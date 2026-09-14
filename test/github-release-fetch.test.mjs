import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchReleaseAsset } from '../scripts/github-release-fetch.mjs';
import { releaseAssetUrl, releaseRepository, releaseTag } from '../scripts/platform-matrix.mjs';

const url = releaseAssetUrl('0.1.1', 'artifact-manifest.json');
const repository = { full_name: releaseRepository };
const release = { tag_name: releaseTag('0.1.1'), draft: false, assets: [{ name: 'artifact-manifest.json', id: 42 }] };

function transport(responses) {
  const calls = [];
  return { calls, options: { token: 'fixture-token', fetchImpl: async (...args) => {
    calls.push(args);
    const next = responses.shift();
    assert.ok(next, 'Unexpected HTTP request');
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : Response.json(next);
  } } };
}

test('internal assets use authenticated repository and release APIs before streaming bytes', async () => {
  const bytes = new Response('engine bytes');
  const { options, calls } = transport([repository, release, bytes]);
  const signal = new AbortController().signal;
  assert.equal(await fetchReleaseAsset(url, { ...options, signal }), bytes);
  assert.deepEqual(calls.map(([path]) => path), [
    `https://api.github.com/repos/${releaseRepository}`,
    `https://api.github.com/repos/${releaseRepository}/releases/tags/${releaseTag('0.1.1')}`,
    `https://api.github.com/repos/${releaseRepository}/releases/assets/42`,
  ]);
  for (const [, init] of calls) {
    assert.equal(init.signal, signal);
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
  }
  assert.equal(calls[2][1].headers.Accept, 'application/octet-stream');
});

test('only a release absent from an accessible repository permits source compilation', async () => {
  const { options } = transport([repository, new Response(null, { status: 404 })]);
  assert.equal((await fetchReleaseAsset(url, options)).status, 404);
  for (const status of [401, 403, 404, 500]) {
    const { options, calls } = transport([new Response(null, { status })]);
    await assert.rejects(fetchReleaseAsset(url, options), /repository access failed/);
    assert.equal(calls.length, 1);
  }
  const mismatch = transport([{ full_name: 'someone/else' }]);
  await assert.rejects(fetchReleaseAsset(url, mismatch.options), /identity mismatch/);
});

test('drafts, tag mismatches, missing or duplicate assets and API errors fail closed', async () => {
  for (const invalid of [
    { ...release, draft: true }, { ...release, tag_name: 'wrong' },
    { ...release, assets: [] }, { ...release, assets: [...release.assets, ...release.assets] },
    { ...release, assets: [{ ...release.assets[0], id: -1 }] },
    new Response(null, { status: 403 }), new Error('network unavailable'),
  ]) {
    const { options, calls } = transport([repository, invalid]);
    await assert.rejects(fetchReleaseAsset(url, options), /draft|tag|exactly one asset|HTTP 403|network unavailable/);
    assert.equal(calls.length, 2);
  }
});

test('credentials are never sent to caller-selected hosts or repositories', async () => {
  for (const invalid of [url.replace('github.com', 'example.com'), url.replace(releaseRepository, 'someone/else'),
    `${url}?token=bad`, `${url}#bad`, url.replace('artifact-manifest.json', '%2fother')]) {
    const { options, calls } = transport([]);
    await assert.rejects(fetchReleaseAsset(invalid, options), /repository|Invalid engine/);
    assert.equal(calls.length, 0);
  }
});
