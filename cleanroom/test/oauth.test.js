import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthStore,
  AuthFileStore,
  loginOAuth,
  createOAuthTokenSource,
  createOAuthHttpProvider,
  OAuthRefreshError
} from '../src/index.js';

test('AuthStore keeps OAuth credentials by provider', async () => {
  const store = new AuthStore();
  await store.set('demo', { type:'oauth', accessToken:'a', refreshToken:'r', expiresAt:1000 });
  assert.deepEqual(await store.get('demo'), { type:'oauth', accessToken:'a', refreshToken:'r', expiresAt:1000 });
});

test('token source returns unexpired access token without refreshing', async () => {
  const store = new AuthStore({ demo:{ type:'oauth', accessToken:'fresh', refreshToken:'r', expiresAt:2000 } });
  let calls = 0;
  const source = createOAuthTokenSource({ provider:'demo', store, now:()=>1000, skewMs:0, refresh: async()=>{ calls++; } });
  assert.equal(await source.getAccessToken(), 'fresh');
  assert.equal(calls, 0);
});

test('token source refreshes expired token and persists replacement', async () => {
  const store = new AuthStore({ demo:{ type:'oauth', accessToken:'old', refreshToken:'r1', expiresAt:900 } });
  const source = createOAuthTokenSource({
    provider:'demo', store, now:()=>1000,
    refresh: async ({refreshToken}) => ({ accessToken:'new', refreshToken:refreshToken+'x', expiresAt:5000 })
  });
  assert.equal(await source.getAccessToken(), 'new');
  assert.deepEqual(await store.get('demo'), { type:'oauth', accessToken:'new', refreshToken:'r1x', expiresAt:5000 });
});

test('refresh failures are typed and preserve cause', async () => {
  const store = new AuthStore({ demo:{ type:'oauth', accessToken:'old', refreshToken:'r', expiresAt:0 } });
  const source = createOAuthTokenSource({ provider:'demo', store, now:()=>1, refresh: async()=>{ throw new Error('denied'); } });
  await assert.rejects(source.getAccessToken(), e => e instanceof OAuthRefreshError && e.provider==='demo' && e.cause?.message==='denied');
});

test('OAuth HTTP provider injects bearer token and normalizes JSON response', async () => {
  const calls=[];
  const provider = createOAuthHttpProvider({
    name:'demo', baseUrl:'https://example.test/v1', tokenSource:{ getAccessToken: async()=> 'token' },
    fetch: async (url, init) => { calls.push({url,init}); return new Response(JSON.stringify({ content:'ok', toolCalls:[] }), {status:200, headers:{'content-type':'application/json'}}); }
  });
  const out = await provider.complete({ model:'m', messages:[{role:'user',content:'hi'}], tools:[] });
  assert.equal(out.content, 'ok');
  assert.equal(calls[0].init.headers.authorization, 'Bearer token');
  assert.equal(calls[0].url, 'https://example.test/v1/responses');
});

test('AuthFileStore persists credentials with private file permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cleanroom-pi-auth-'));
  const path = join(dir, 'auth.json');
  const store = new AuthFileStore(path);
  await store.set('demo', { type:'oauth', accessToken:'a', refreshToken:'r', expiresAt:123 });
  const reloaded = new AuthFileStore(path);
  assert.equal((await reloaded.get('demo')).accessToken, 'a');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(await readFile(path, 'utf8'), /"demo"/);
});

test('loginOAuth delegates authorization to provider plugin and stores credentials', async () => {
  const store = new AuthStore();
  const seen = [];
  const credentials = await loginOAuth({
    provider:'demo', store,
    oauth:{ async login(callbacks) { callbacks.onAuth?.({url:'https://example.test/auth'}); return { accessToken:'a', refreshToken:'r', expiresAt:9999 }; } },
    callbacks:{ onAuth: x => seen.push(x.url) }
  });
  assert.equal(credentials.type, 'oauth');
  assert.deepEqual(seen, ['https://example.test/auth']);
  assert.equal((await store.get('demo')).refreshToken, 'r');
});
