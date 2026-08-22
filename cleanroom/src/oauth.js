export class OAuthRefreshError extends Error {
  constructor(provider, message = 'OAuth token refresh failed', options = {}) {
    super(message, options);
    this.name = 'OAuthRefreshError';
    this.provider = provider;
  }
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export class AuthStore {
  #entries = new Map();

  constructor(initial = {}) {
    for (const [provider, credentials] of Object.entries(initial)) {
      this.#entries.set(provider, clone(credentials));
    }
  }

  async get(provider) {
    return clone(this.#entries.get(provider));
  }

  async set(provider, credentials) {
    if (!provider) throw new TypeError('provider is required');
    if (!credentials || credentials.type !== 'oauth') throw new TypeError('OAuth credentials are required');
    if (typeof credentials.accessToken !== 'string' || !credentials.accessToken) throw new TypeError('accessToken is required');
    this.#entries.set(provider, clone(credentials));
  }

  async delete(provider) {
    return this.#entries.delete(provider);
  }
}

export class AuthFileStore extends AuthStore {
  constructor(path) {
    super();
    if (!path) throw new TypeError('path is required');
    this.path = path;
  }

  async #readAll() {
    const { readFile } = await import('node:fs/promises');
    try {
      const text = await readFile(this.path, 'utf8');
      return text.trim() ? JSON.parse(text) : {};
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  }

  async #writeAll(entries) {
    const { mkdir, writeFile, chmod } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(entries, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  async get(provider) {
    const entries = await this.#readAll();
    return clone(entries[provider]);
  }

  async set(provider, credentials) {
    if (!provider) throw new TypeError('provider is required');
    if (!credentials || credentials.type !== 'oauth') throw new TypeError('OAuth credentials are required');
    if (typeof credentials.accessToken !== 'string' || !credentials.accessToken) throw new TypeError('accessToken is required');
    const entries = await this.#readAll();
    entries[provider] = clone(credentials);
    await this.#writeAll(entries);
  }

  async delete(provider) {
    const entries = await this.#readAll();
    const existed = Object.hasOwn(entries, provider);
    delete entries[provider];
    await this.#writeAll(entries);
    return existed;
  }
}

export async function loginOAuth({ provider, oauth, store, callbacks = {} }) {
  if (!provider) throw new TypeError('provider is required');
  if (!oauth || typeof oauth.login !== 'function') throw new TypeError('oauth.login is required');
  if (!store || typeof store.set !== 'function') throw new TypeError('store.set is required');
  const result = await oauth.login(callbacks);
  if (!result || typeof result.accessToken !== 'string' || !result.accessToken) {
    throw new TypeError('oauth.login must return accessToken');
  }
  const credentials = {
    type: 'oauth',
    accessToken: result.accessToken,
    ...(result.refreshToken != null ? { refreshToken: result.refreshToken } : {}),
    ...(result.expiresAt != null ? { expiresAt: result.expiresAt } : {}),
    ...(result.scope != null ? { scope: result.scope } : {}),
    ...(result.tokenType != null ? { tokenType: result.tokenType } : {})
  };
  await store.set(provider, credentials);
  return clone(credentials);
}

export function createOAuthTokenSource({ provider, store, refresh, now = Date.now, skewMs = 30_000 }) {
  if (!provider) throw new TypeError('provider is required');
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') throw new TypeError('store.get/store.set are required');
  if (typeof refresh !== 'function') throw new TypeError('refresh is required');

  let inflight;

  async function getAccessToken() {
    const credentials = await store.get(provider);
    if (!credentials) throw new OAuthRefreshError(provider, `no OAuth credentials for ${provider}`);

    const expiresAt = Number(credentials.expiresAt ?? 0);
    if (credentials.accessToken && (credentials.expiresAt == null || expiresAt - skewMs > now())) return credentials.accessToken;
    if (!credentials.refreshToken) throw new OAuthRefreshError(provider, `OAuth credentials for ${provider} cannot be refreshed`);

    if (!inflight) {
      inflight = (async () => {
        try {
          const next = await refresh({
            provider,
            refreshToken: credentials.refreshToken,
            credentials: clone(credentials)
          });
          if (!next || typeof next.accessToken !== 'string' || !next.accessToken) {
            throw new TypeError('refresh must return accessToken');
          }
          const merged = {
            type: 'oauth',
            accessToken: next.accessToken,
            refreshToken: next.refreshToken ?? credentials.refreshToken,
            expiresAt: next.expiresAt ?? 0,
            ...('scope' in next ? { scope: next.scope } : {}),
            ...('tokenType' in next ? { tokenType: next.tokenType } : {})
          };
          await store.set(provider, merged);
          return merged.accessToken;
        } catch (cause) {
          if (cause instanceof OAuthRefreshError) throw cause;
          throw new OAuthRefreshError(provider, `OAuth token refresh failed for ${provider}`, { cause });
        } finally {
          inflight = undefined;
        }
      })();
    }
    return inflight;
  }

  return { getAccessToken };
}

export function createOAuthHttpProvider({
  name,
  baseUrl,
  tokenSource,
  fetch: fetchImpl = globalThis.fetch,
  path = '/responses',
  transformRequest = request => request,
  transformResponse = body => body
}) {
  if (!name) throw new TypeError('name is required');
  if (!baseUrl) throw new TypeError('baseUrl is required');
  if (!tokenSource || typeof tokenSource.getAccessToken !== 'function') throw new TypeError('tokenSource.getAccessToken is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');

  return {
    name,
    async complete(request) {
      const token = await tokenSource.getAccessToken();
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(await transformRequest(clone(request))),
        signal: request.signal
      });

      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; }
      catch (cause) { throw new Error(`invalid JSON from ${name}`, { cause }); }

      if (!response.ok) {
        const message = body?.error?.message ?? body?.message ?? `${name} HTTP ${response.status}`;
        throw new Error(message);
      }
      return transformResponse(body, response);
    }
  };
}
