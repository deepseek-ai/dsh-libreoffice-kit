#!/usr/bin/env node
/** Builds pinned official LibreOffice source into immutable Node.js WASM assets. */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readWasmSource } from './source.mjs';

const owner = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(owner, '../..');
const cache = path.join(repository, '.build/wasm');
const pinned = readWasmSource();
const stages = ['prepare', 'verify', 'configure', 'compile', 'build', 'package'];
const { values } = parseArgs({
  options: {
    stage: { type: 'string', default: 'build' },
    source: { type: 'string', default: path.join(cache, 'core') },
    emsdk: { type: 'string', default: path.join(cache, 'emsdk') },
    build: { type: 'string', default: path.join(cache, 'build') },
    tarballs: { type: 'string', default: path.join(cache, 'tarballs') },
    output: { type: 'string', default: path.join(cache, 'dist') },
    jobs: { type: 'string', default: String(availableParallelism()) },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`Usage: node engine/wasm-source/build.mjs [--stage ${stages.join('|')}] [--source DIR] [--emsdk DIR] [--build DIR] [--tarballs DIR] [--output DIR] [--jobs N]`);
  process.exit(0);
}
if (!stages.includes(values.stage)) throw new Error(`Unknown build stage: ${values.stage}`);
const jobs = Number(values.jobs);
if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('--jobs must be a positive integer');

const source = path.resolve(values.source);
const emsdk = path.resolve(values.emsdk);
const build = path.resolve(values.build);
const tarballs = path.resolve(values.tarballs);
const output = path.resolve(values.output);
const receiptPath = path.join(build, 'dsh-wasm-build.json');
const shimTarget = path.join(source, 'desktop/source/lib/dsh_wasm.cxx');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)));
env.MAKE = env.GNUMAKE || env.MAKE || (process.platform === 'darwin' ? 'gmake' : 'make');
const artifacts = {
  'soffice.cjs': 'soffice.js',
  'soffice.wasm': 'soffice.wasm',
  'soffice.data': 'soffice.data',
  'soffice.data.js.metadata': 'soffice.data.js.metadata',
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repository, env, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.signal ?? result.status}${result.stderr ? `\n${result.stderr.trim()}` : ''}`);
  }
  return result.stdout?.trim();
}

function git(args, cwd = source) {
  return run('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hashFile(filename) {
  if (!lstatSync(filename).isFile()) throw new Error(`Expected a regular build file: ${filename}`);
  return sha256(readFileSync(filename));
}

function patches() {
  const files = readdirSync(path.join(owner, pinned.patches)).filter((name) => name.endsWith('.patch')).sort();
  if (files.length === 0) throw new Error('No LibreOffice WASM patches were found');
  return files.map((name) => path.join(owner, pinned.patches, name));
}

function requireCheckout(directory, specification) {
  if (!existsSync(path.join(directory, '.git'))) {
    throw new Error(`Missing official checkout at ${directory}; clone ${specification.repository} and check out ${specification.commit}`);
  }
  const actual = git(['rev-parse', 'HEAD'], directory);
  if (actual !== specification.commit) {
    throw new Error(`${directory} is at ${actual}; required official commit is ${specification.commit}`);
  }
}

function requireCheckouts() {
  requireCheckout(source, pinned.libreoffice);
  requireCheckout(emsdk, pinned.emsdk);
}

function checkPatch(patch, reverse = false) {
  const args = ['apply', '--check', ...(reverse ? ['--reverse'] : []), patch];
  const result = spawnSync('git', args, { cwd: source, env, stdio: 'ignore' });
  if (result.error) throw result.error;
  return result.status === 0;
}

function prepare() {
  requireCheckouts();
  for (const patch of patches()) {
    if (checkPatch(patch)) run('git', ['apply', patch], { cwd: source });
    else if (!checkPatch(patch, true)) {
      throw new Error(`Official source differs from ${path.basename(patch)}; preserve local edits and reconcile the patch`);
    }
  }
  const shim = readFileSync(path.join(owner, pinned.shim));
  if (!existsSync(shimTarget) || !readFileSync(shimTarget).equals(shim)) {
    writeFileSync(shimTarget, shim);
  }
}

function withEmsdk(command, args, options = {}) {
  return run('bash', ['-c', 'set -e\nsource "$1" >/dev/null\nshift\nexec "$@"', 'dsh-libreoffice-build', path.join(emsdk, 'emsdk_env.sh'), command, ...args], options);
}

function verifyRecipe() {
  requireCheckouts();
  for (const patch of patches()) {
    if (!checkPatch(patch, true)) throw new Error(`${path.basename(patch)} is not applied; run the prepare stage`);
  }
  if (!existsSync(shimTarget) || hashFile(shimTarget) !== hashFile(path.join(owner, pinned.shim))) {
    throw new Error('The LibreOfficeKit shim differs from the recipe; run the prepare stage');
  }
  const version = withEmsdk('emcc', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (!version.split('\n')[0].includes(` ${pinned.emsdk.version} `)) {
    throw new Error(`Emscripten ${pinned.emsdk.version} is required; found ${version.split('\n')[0]}`);
  }
  return version;
}

function configure() {
  verifyRecipe();
  mkdirSync(build, { recursive: true });
  mkdirSync(tarballs, { recursive: true });
  const configuration = readFileSync(path.join(owner, 'autogen.input'), 'utf8');
  writeFileSync(path.join(build, 'autogen.input'), `${configuration}--with-external-tar=${tarballs}\n--with-parallelism=${jobs}\n`);
  withEmsdk(path.join(source, 'autogen.sh'), [], { cwd: build });
}

function buildInputs() {
  return {
    source: readWasmSource(),
    recipe: hashFile(path.join(owner, 'autogen.input')),
    configuration: hashFile(path.join(build, 'autogen.input')),
    hostConfiguration: hashFile(path.join(build, 'config_host.mk')),
    buildConfiguration: hashFile(path.join(build, 'config_build.mk')),
    sourceChanges: sha256(git(['diff', '--binary', 'HEAD', '--'])),
    shim: hashFile(shimTarget),
    toolchain: verifyRecipe(),
    patches: Object.fromEntries(patches().map((patch) => [path.basename(patch), hashFile(patch)])),
  };
}

function artifactHashes() {
  const program = path.join(build, 'instdir/program');
  const metadata = JSON.parse(readFileSync(path.join(program, 'soffice.data.js.metadata'), 'utf8'));
  if (!Array.isArray(metadata.files) || metadata.files.some((file) => typeof file.filename !== 'string')) {
    throw new Error('The LibreOffice WASM data metadata has no valid file inventory');
  }
  const fonts = metadata.files.filter((file) => /\.(?:ttf|otf|ttc|otc|woff2?|dfont|pfa|pfb|pfr|bdf|pcf)(?:\.gz)?$/i.test(file.filename));
  if (fonts.length > 0) throw new Error(`The LibreOffice WASM bundle contains fonts: ${fonts.map((file) => file.filename).join(', ')}`);
  return Object.fromEntries(Object.entries(artifacts).map(([name, filename]) => [name, hashFile(path.join(program, filename))]));
}

function compile() {
  const inputs = buildInputs();
  withEmsdk(env.MAKE, ['build', `PARALLELISM=${jobs}`], { cwd: build });
  if (JSON.stringify(inputs) !== JSON.stringify(buildInputs())) {
    throw new Error('LibreOffice build inputs changed during compilation; rerun the compile stage');
  }
  const files = artifactHashes();
  writeFileSync(receiptPath, `${JSON.stringify({ inputs, files }, null, 2)}\n`);
}

function packageArtifacts() {
  if (!existsSync(receiptPath)) throw new Error('No successful LibreOffice build receipt exists; run the compile stage');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const inputs = buildInputs();
  const files = artifactHashes();
  if (JSON.stringify(receipt.inputs) !== JSON.stringify(inputs) || JSON.stringify(receipt.files) !== JSON.stringify(files)) {
    throw new Error('LibreOffice sources or assets differ from the successful build receipt; rerun the compile stage');
  }
  const manifest = {
    schemaVersion: 2,
    runtime: 'node',
    entry: 'soffice.cjs',
    wasm: 'soffice.wasm',
    data: 'soffice.data',
    metadata: 'soffice.data.js.metadata',
    programPath: '/instdir/program',
    version: pinned.libreoffice.version,
    sourceCommit: pinned.libreoffice.commit,
    buildId: sha256(JSON.stringify({ inputs, files })),
    files,
    inputs,
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existsSync(output)) {
    const prior = path.join(output, 'manifest.json');
    if (!existsSync(prior) || readFileSync(prior, 'utf8') !== serialized
      || Object.entries(files).some(([name, hash]) => hashFile(path.join(output, name)) !== hash)) {
      throw new Error(`The artifact directory already contains a different or incomplete bundle: ${output}; choose a new --output directory`);
    }
  } else {
    mkdirSync(path.dirname(output), { recursive: true });
    const staging = mkdtempSync(path.join(path.dirname(output), `.${path.basename(output)}-`));
    let published = false;
    try {
      for (const [name, filename] of Object.entries(artifacts)) {
        const target = path.join(staging, name);
        copyFileSync(path.join(build, 'instdir/program', filename), target);
        if (hashFile(target) !== files[name]) throw new Error(`LibreOffice asset changed during packaging: ${filename}`);
      }
      writeFileSync(path.join(staging, 'manifest.json'), serialized);
      renameSync(staging, output);
      published = true;
    } finally {
      if (!published) rmSync(staging, { recursive: true, force: true });
    }
  }
  console.log(`LibreOffice ${manifest.version} WASM bundle: ${output}`);
  console.log(`Build ID: ${manifest.buildId}`);
}

switch (values.stage) {
  case 'prepare':
    prepare();
    break;
  case 'verify':
    verifyRecipe();
    console.log('Pinned source, patches, LibreOfficeKit shim and Emscripten verified.');
    break;
  case 'configure':
    prepare();
    configure();
    break;
  case 'compile':
    compile();
    break;
  case 'build':
    prepare();
    configure();
    compile();
    packageArtifacts();
    break;
  case 'package':
    packageArtifacts();
    break;
}
