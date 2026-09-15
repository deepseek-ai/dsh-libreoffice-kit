import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNpmOidc } from '../scripts/verify-npm-oidc.mjs';
import { sourceRepository } from '../scripts/platform-matrix.mjs';

function fixture() {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: sourceRepository,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/example/idtoken?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-secret' };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return options.method === 'POST'
      ? { status: 201, json: async () => ({ token_type: 'oidc', token: 'npm-exchange-secret' }) }
      : { status: 200, json: async () => ({ value: 'github-identity-secret' }) };
  };
  return { env, calls, fetchImpl };
}

test('OIDC verification exchanges tokens for exactly the six release packages without publishing', async () => {
  const f = fixture();
  const result = await verifyNpmOidc(f);
  assert.deepEqual(result, { verifiedPackages: 6 });
  assert.equal(f.calls.length, 12);
  const packages = [];
  for (let index = 0; index < f.calls.length; index += 2) {
    const identity = f.calls[index];
    assert.equal(new URL(identity.url).searchParams.get('audience'), 'npm:registry.npmjs.org');
    assert.equal(identity.options.headers.Authorization, 'Bearer runner-request-secret');
    assert.equal(identity.options.method, undefined);
    const exchange = f.calls[index + 1];
    const prefix = 'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/';
    assert.ok(exchange.url.startsWith(prefix));
    packages.push(decodeURIComponent(exchange.url.slice(prefix.length)));
    assert.equal(exchange.options.headers.Authorization, 'Bearer github-identity-secret');
    assert.equal(exchange.options.method, 'POST');
    assert.equal(exchange.options.body, undefined);
    for (const { options } of [identity, exchange]) {
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
    }
  }
  assert.deepEqual(packages.sort(), [
    '@deepseek-ai/libreoffice-kit', '@deepseek-ai/libreoffice-kit-darwin-arm64',
    '@deepseek-ai/libreoffice-kit-darwin-x64', '@deepseek-ai/libreoffice-kit-wasm',
    '@deepseek-ai/libreoffice-kit-win32-arm64', '@deepseek-ai/libreoffice-kit-win32-x64',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('OIDC verification rejects non-CI, wrong repository and missing permissions before network access', async () => {
  for (const changes of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'another/repo' },
    { ACTIONS_ID_TOKEN_REQUEST_URL: '' }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }]) {
    const f = fixture();
    Object.assign(f.env, changes);
    await assert.rejects(verifyNpmOidc(f));
    assert.equal(f.calls.length, 0);
  }
});

test('OIDC verification never sends request credentials to an arbitrary or insecure origin', async () => {
  for (const url of ['not a URL', 'http://pipelines.actions.githubusercontent.com/token',
    'https://pipelines.actions.githubusercontent.com.evil.example/token', 'https://example.com/token',
    'https://user:password@pipelines.actions.githubusercontent.com/token',
    'https://pipelines.actions.githubusercontent.com:444/token', 'https://pipelines.actions.githubusercontent.com/token#fragment']) {
    const f = fixture();
    f.env.ACTIONS_ID_TOKEN_REQUEST_URL = url;
    await assert.rejects(verifyNpmOidc(f), /Invalid GitHub OIDC request URL/);
    assert.equal(f.calls.length, 0);
  }
});

test('OIDC failures fail closed and suppress transport, response and token contents', async () => {
  for (const stage of ['identity', 'exchange']) {
    for (const failure of ['transport', 'status', 'json', 'token']) {
      const f = fixture();
      const normalFetch = f.fetchImpl;
      let calls = 0;
      f.fetchImpl = async (url, options) => {
        calls += 1;
        if ((options.method === 'POST') !== (stage === 'exchange')) return normalFetch(url, options);
        if (failure === 'transport') throw new Error('transport secret');
        if (failure === 'status') return { status: 401, json: async () => ({ message: 'response secret' }) };
        return { status: stage === 'exchange' ? 201 : 200,
          json: async () => {
            if (failure === 'json') throw new Error('json secret');
            return stage === 'exchange' ? { token_type: 'wrong', token: 'npm secret' } : { error: 'identity secret' };
          } };
      };
      await assert.rejects(verifyNpmOidc(f), error => {
        assert.doesNotMatch(error.message, /secret/);
        assert.match(error.message, /OIDC for @deepseek-ai\/libreoffice-kit/);
        return true;
      });
      assert.equal(calls, stage === 'exchange' ? 2 : 1);
    }
  }
});
