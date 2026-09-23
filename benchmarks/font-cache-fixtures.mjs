/** Generate public font-cache regression inputs; the fixed OFL font is supplied by the caller. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { documentFixture } from '../test/runtime-fixture.mjs';
const { unzipSync, zipSync, strFromU8, strToU8 } = createRequire(new URL('../packages/entry/package.json', import.meta.url))('fflate');
const { values } = parseArgs({ options: { output: { type: 'string' }, font: { type: 'string' } } });
assert.ok(values.output && values.font, 'Supply --output and --font (Carlito-Regular.ttf).');
const bytes = await fs.readFile(values.font);
assert.equal(createHash('sha256').update(bytes).digest('hex'), 'f6418f708baede9789daef5d458c0f53d2a888af9820e8062934e504fedc6595', 'Use the pinned Carlito font from the benchmark README.');
const output = resolve(values.output); await fs.mkdir(output, { mode: 0o700 });
const fonts = join(output, 'fonts'); await fs.mkdir(fonts, { mode: 0o700 });
await fs.writeFile(join(fonts, 'Carlito-Regular.ttf'), bytes, { flag: 'wx', mode: 0o600 });
const inputs = [];
for (const extension of ['docx', 'pptx', 'xlsx']) {
  let document;
  if (extension === 'docx') document = documentFixture('Font metadata cache ABC abc 123 fi fl', 'Carlito');
  else {
    const files = unzipSync(await fs.readFile(new URL(`../test/fixtures/${extension === 'pptx' ? 'one-slide.pptx' : 'one-sheet.xlsx'}`, import.meta.url)));
    for (const [name, contents] of Object.entries(files)) if (name.endsWith('.xml')) files[name] = strToU8(strFromU8(contents)
      .replace(/typeface="[^"]*"/g, 'typeface="Carlito"').replace(/<name val="[^"]*"/g, '<name val="Carlito"'));
    document = zipSync(files);
  }
  const path = join(output, `public.${extension}`); await fs.writeFile(path, document, { flag: 'wx', mode: 0o600 });
  inputs.push({ id: `public-${extension}`, path, options: { fontDirectories: [fonts] } });
}
await fs.writeFile(join(output, 'inputs.json'), JSON.stringify(inputs, null, 2), { flag: 'wx', mode: 0o600 });
