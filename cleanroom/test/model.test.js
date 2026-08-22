import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderModel, ScriptedProvider, ProviderError } from '../src/index.js';

test('adapts normalized agent requests to a provider', async () => {
  const seen = [];
  const provider = {
    async complete(req) {
      seen.push(req);
      return {
        text: 'hello',
        tool_calls: [{ id: 'c1', name: 'sum', arguments: { a: 1, b: 2 } }],
        usage: { input: 3, output: 2 }
      };
    }
  };
  const model = createProviderModel(provider, { model: 'demo-1', system: 'be terse' });
  const out = await model.complete({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'sum' }],
    context: { traceId: 't1' }
  });
  assert.equal(seen[0].model, 'demo-1');
  assert.equal(seen[0].system, 'be terse');
  assert.deepEqual(seen[0].messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(out, {
    content: 'hello',
    toolCalls: [{ id: 'c1', name: 'sum', input: { a: 1, b: 2 } }],
    usage: { input: 3, output: 2 }
  });
});

test('provider model options can be overridden per call through context', async () => {
  const provider = new ScriptedProvider([{ text: 'ok' }]);
  const model = createProviderModel(provider, { model: 'default' });
  await model.complete({
    messages: [],
    tools: [],
    context: { provider: { model: 'override', temperature: 0.2 } }
  });
  assert.equal(provider.requests[0].model, 'override');
  assert.equal(provider.requests[0].temperature, 0.2);
});

test('scripted provider is deterministic and clone-safe', async () => {
  const provider = new ScriptedProvider([{ text: 'a' }, { text: 'b' }]);
  const a = await provider.complete({ messages: [] });
  a.text = 'mutated';
  const b = await provider.complete({ messages: [] });
  assert.equal(b.text, 'b');
  assert.equal(provider.requests.length, 2);
});

test('provider failures preserve cause and provider identity', async () => {
  const cause = new Error('network down');
  const provider = { name: 'demo', async complete() { throw cause; } };
  const model = createProviderModel(provider);
  await assert.rejects(() => model.complete({ messages: [], tools: [] }), err => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.provider, 'demo');
    assert.equal(err.cause, cause);
    return true;
  });
});
