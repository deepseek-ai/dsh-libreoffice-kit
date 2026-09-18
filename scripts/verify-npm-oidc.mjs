import { enginePrefix, isMain, kitManifest, releaseTargets, sourceRepository } from './platform-matrix.mjs';

const audience = 'npm:registry.npmjs.org';

async function requestJson(fetchImpl, url, options, expectedStatus, operation) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error(`${operation} request failed`);
  }
  if (response.status !== expectedStatus) throw new Error(`${operation} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

/**
 * Verify each released package's trusted-publisher exchange without publishing.
 * Tokens remain in memory and are discarded; exchange success does not prove
 * that the publisher allows direct publishing instead of staging only.
 * https://api-docs.npmjs.com/#tag/OIDC/operation/exchangeOidcToken
 */
export async function verifyNpmOidc({ env = process.env, fetchImpl = fetch, packages = [kitManifest().name, ...releaseTargets([]).map(platform => `${enginePrefix}-${platform}`)] } = {}) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== sourceRepository) {
    throw new Error('npm OIDC verification requires this repository in GitHub Actions');
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('npm OIDC verification requires id-token: write');
  }
  let tokenUrl;
  try {
    tokenUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  } catch {
    throw new Error('Invalid GitHub OIDC request URL');
  }
  if (tokenUrl.protocol !== 'https:' || !tokenUrl.hostname.endsWith('.actions.githubusercontent.com')
      || tokenUrl.username || tokenUrl.password || tokenUrl.port || tokenUrl.hash) {
    throw new Error('Invalid GitHub OIDC request URL');
  }
  tokenUrl.searchParams.set('audience', audience);
  const allowed = new Set([kitManifest().name, ...releaseTargets([]).map(platform => `${enginePrefix}-${platform}`)]);
  if (!Array.isArray(packages) || packages.length === 0 || new Set(packages).size !== packages.length || packages.some(name => !allowed.has(name)))
    throw new Error('npm OIDC verification requires declared package names');
  for (const name of packages) {
    const identity = await requestJson(fetchImpl, tokenUrl.href, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    }, 200, `GitHub OIDC for ${name}`);
    if (typeof identity?.value !== 'string' || !identity.value) throw new Error(`GitHub OIDC for ${name} returned no token`);
    const exchange = await requestJson(fetchImpl,
      `https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${identity.value}` },
      }, 201, `npm OIDC for ${name}`);
    if (exchange?.token_type !== 'oidc' || typeof exchange.token !== 'string' || !exchange.token) {
      throw new Error(`npm OIDC for ${name} returned no exchange token`);
    }
  }
  return { verifiedPackages: packages.length };
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await verifyNpmOidc()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
