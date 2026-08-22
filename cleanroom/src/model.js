export class ProviderError extends Error {
  constructor(provider, cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`provider ${provider} failed: ${message}`, { cause });
    this.name = 'ProviderError';
    this.provider = provider;
  }
}

function assertProvider(provider) {
  if (!provider || typeof provider.complete !== 'function') {
    throw new TypeError('provider.complete is required');
  }
}

function normalizeToolCall(call) {
  if (!call || typeof call !== 'object') throw new TypeError('provider returned invalid tool call');
  const id = call.id;
  const name = call.name;
  if (!id || !name) throw new TypeError('provider tool call requires id and name');
  return { id, name, input: structuredClone(call.arguments ?? call.input ?? {}) };
}

function normalizeResponse(response) {
  if (!response || typeof response !== 'object') throw new TypeError('provider returned invalid response');
  const rawCalls = response.tool_calls ?? response.toolCalls ?? [];
  if (!Array.isArray(rawCalls)) throw new TypeError('provider tool calls must be an array');
  const out = {
    content: typeof response.text === 'string'
      ? response.text
      : (typeof response.content === 'string' ? response.content : ''),
    toolCalls: rawCalls.map(normalizeToolCall)
  };
  if (response.usage !== undefined) out.usage = structuredClone(response.usage);
  return out;
}

export function createProviderModel(provider, defaults = {}) {
  assertProvider(provider);
  const providerName = provider.name || 'anonymous';

  return {
    provider: providerName,
    async complete({ messages = [], tools = [], signal, context = {} } = {}) {
      const callOptions = context?.provider && typeof context.provider === 'object'
        ? context.provider
        : {};
      const request = {
        ...structuredClone(defaults),
        ...structuredClone(callOptions),
        messages: structuredClone(messages),
        tools: structuredClone(tools),
        signal
      };
      try {
        return normalizeResponse(await provider.complete(request));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(providerName, error);
      }
    }
  };
}

export class ScriptedProvider {
  constructor(script, { name = 'scripted' } = {}) {
    if (!Array.isArray(script)) throw new TypeError('script must be an array');
    this.name = name;
    this.script = structuredClone(script);
    this.requests = [];
    this.index = 0;
  }

  async complete(request) {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    if (this.index >= this.script.length) throw new Error('script exhausted');
    return structuredClone(this.script[this.index++]);
  }
}
