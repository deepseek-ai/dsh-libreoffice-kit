/** Verify an installed CLI whose engine lives beneath a long installation root. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [consumer, output, receipt] = process.argv.slice(2);
const { renderOfficeCliContent } = await import(pathToFileURL(join(consumer, 'test/runtime-render-content.mjs')));
const result = await renderOfficeCliContent(join(consumer, 'node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js'), output, 'native');
await writeFile(receipt, `${JSON.stringify(result)}\n`);
