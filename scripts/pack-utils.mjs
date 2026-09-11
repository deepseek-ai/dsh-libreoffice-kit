/** Local-only npm helpers shared by packaging and offline-install rehearsals. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from './platform-matrix.mjs';

export function scratch(prefix = 'packaging-') {
  const parent = join(root, '.cache');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status} (${result.signal ?? 'no signal'}):\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

/** Invoke npm's JS CLI directly, including on Windows; no command shell is used. */
export function npmCli() {
  const directories = [dirname(process.execPath), dirname(realpathSync(process.execPath)), ...(process.env.PATH ?? '').split(delimiter)];
  const candidates = [process.env.npm_execpath];
  for (const directory of directories) {
    candidates.push(join(directory, 'node_modules/npm/bin/npm-cli.js'), resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js'));
    const link = join(directory, 'npm');
    if (existsSync(link)) candidates.push(realpathSync(link));
  }
  const found = candidates.find((file) => file && /(?:^|[\\/])npm-cli\.js$/.test(file) && existsSync(file));
  if (!found) throw new Error('npm-cli.js was not found next to Node or on PATH');
  return found;
}

export function npmEnvironment(work) {
  const config = join(work, 'empty.npmrc');
  const globalConfig = join(work, 'empty-global.npmrc');
  writeFileSync(config, '');
  writeFileSync(globalConfig, '');
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$|^NPM_CONFIG_/i.test(key))),
    npm_config_cache: join(work, 'npm-cache'),
    npm_config_userconfig: config,
    npm_config_globalconfig: globalConfig,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_registry: 'http://127.0.0.1:9',
    npm_config_offline: 'true',
  };
}

export function npm(args, cwd, work) {
  return run(process.execPath, [npmCli(), ...args], { cwd, env: npmEnvironment(work) });
}
