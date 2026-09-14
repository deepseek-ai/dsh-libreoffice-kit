/** Authenticated build-time access to the internal engine release repository. */
import { spawnSync } from 'node:child_process';
import { releaseRepository } from './platform-matrix.mjs';
import { assert } from './verify-artifacts.mjs';

function localToken() {
  const token = process.env.LIBREOFFICE_KIT_GITHUB_TOKEN;
  if (token) return token;
  const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert(result.status === 0 && result.stdout.trim(), 'Internal engine downloads require gh auth login or LIBREOFFICE_KIT_GITHUB_TOKEN');
  return result.stdout.trim();
}

/**
 * Resolve an internal release asset through GitHub's authenticated API.
 * A release 404 is returned only after repository access succeeds; absent assets,
 * drafts, authentication failures, and network errors reject.
 * @param url - Versioned browser asset URL from releaseAssetUrl.
 * @param options - Abort signal, GitHub token, and injectable HTTP transport.
 * @returns Streaming asset response, or a response with status 404 for an absent release.
 */
export async function fetchReleaseAsset(url, { signal, token = localToken(), fetchImpl = fetch } = {}) {
  const parsed = new URL(url);
  const prefix = `/${releaseRepository}/releases/download/`;
  assert(parsed.origin === 'https://github.com' && parsed.pathname.startsWith(prefix) && !parsed.search && !parsed.hash,
    'Engine asset must belong to the internal release repository');
  const parts = parsed.pathname.slice(prefix.length).split('/').map(decodeURIComponent);
  assert(parts.length === 2 && parts.every(part => part && !part.includes('/')), 'Invalid engine release asset URL');
  const [tag, file] = parts;
  const api = `https://api.github.com/repos/${releaseRepository}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const access = await fetchImpl(api, { signal, headers });
  assert(access.ok, `Internal engine repository access failed: HTTP ${access.status}`);
  assert((await access.json()).full_name === releaseRepository, 'Internal engine repository identity mismatch');
  const response = await fetchImpl(`${api}/releases/tags/${encodeURIComponent(tag)}`, { signal, headers });
  if (response.status === 404) { await response.body?.cancel(); return new Response(null, { status: 404 }); }
  assert(response.ok, `Internal engine release request failed: HTTP ${response.status}`);
  const release = await response.json();
  assert(release.tag_name === tag && release.draft === false, 'Engine release tag mismatch or draft is not published');
  const assets = release.assets?.filter(asset => asset.name === file);
  assert(assets?.length === 1 && Number.isSafeInteger(assets[0].id) && assets[0].id > 0, `Internal engine release must contain exactly one asset: ${file}`);
  return fetchImpl(`${api}/releases/assets/${assets[0].id}`, { signal, headers: { ...headers, Accept: 'application/octet-stream' } });
}
