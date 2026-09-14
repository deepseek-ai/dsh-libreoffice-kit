import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyReleaseSourceTag } from '../scripts/release-source-tag.mjs';
import { sourceRepository } from '../scripts/platform-matrix.mjs';

const tag = 'libreoffice-kit-v0.1.1';
const source = { repository: sourceRepository, commit: '1'.repeat(40) };
const ok = object => ({ status: 0, stdout: JSON.stringify({ object }) });

for (const annotated of [false, true]) test(`${annotated ? 'annotated' : 'lightweight'} release tags identify the qualified source without writes`, () => {
  const calls = [];
  const run = args => {
    calls.push(args);
    if (annotated && args[1].includes('/git/ref/')) return ok({ type: 'tag', sha: '2'.repeat(40) });
    return ok({ type: 'commit', sha: source.commit });
  };
  verifyReleaseSourceTag(sourceRepository, tag, source, run);
  assert.deepEqual(calls, [
    ['api', `repos/${sourceRepository}/git/ref/tags/${tag}`],
    ...(annotated ? [['api', `repos/${sourceRepository}/git/tags/${'2'.repeat(40)}`]] : []),
  ]);
});

test('missing tags, inaccessible tags and different source commits reject publication', () => {
  for (const result of [
    { status: 1, stderr: 'HTTP 404' }, { status: 1, stderr: 'HTTP 403' },
    ok({ type: 'commit', sha: '3'.repeat(40) }), ok({ type: 'tree', sha: source.commit }),
  ]) assert.throws(() => verifyReleaseSourceTag(sourceRepository, tag, source, () => result), /failed|differs/);
  assert.throws(() => verifyReleaseSourceTag('another/repository', tag, source, () => assert.fail('must reject before API access')), /repositories differ/);
});
