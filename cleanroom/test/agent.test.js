import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentAbortError, MaxStepsError, ToolRegistry, runAgent } from '../src/index.js';

function scriptedModel(script) {
  let i = 0;
  return { async complete() { if (i >= script.length) throw new Error('script exhausted'); return structuredClone(script[i++]); } };
}

test('completes without tools', async () => {
  const result = await runAgent({ model: scriptedModel([{ content: 'done' }]), messages: [{ role: 'user', content: 'go' }] });
  assert.equal(result.content, 'done');
  assert.equal(result.steps, 1);
});

test('executes a tool and feeds result back to model', async () => {
  const seen = [];
  const model = {
    async complete(req) {
      seen.push(req);
      return seen.length === 1
        ? { content: '', toolCalls: [{ id: '1', name: 'add', input: { a: 2, b: 3 } }] }
        : { content: `sum=${req.messages.at(-1).content}` };
    }
  };
  const tools = new ToolRegistry().register({ name: 'add', execute: ({ a, b }) => a + b });
  const result = await runAgent({ model, tools });
  assert.equal(result.content, 'sum=5');
  assert.equal(result.messages.at(-2).ok, true);
});

test('tool failures become tool messages and do not crash loop', async () => {
  const model = scriptedModel([
    { toolCalls: [{ id: 'x', name: 'boom', input: {} }] },
    { content: 'recovered' }
  ]);
  const tools = new ToolRegistry().register({ name: 'boom', execute() { throw new Error('broken'); } });
  const result = await runAgent({ model, tools });
  assert.equal(result.content, 'recovered');
  const tool = result.messages.find(m => m.role === 'tool');
  assert.equal(tool.ok, false);
  assert.equal(tool.content, 'broken');
});

test('unknown tools become explicit failures', async () => {
  const result = await runAgent({
    model: scriptedModel([{ toolCalls: [{ id: 'x', name: 'missing' }] }, { content: 'ok' }])
  });
  const tool = result.messages.find(m => m.role === 'tool');
  assert.match(tool.content, /unknown tool/);
});

test('aborts before model execution', async () => {
  const controller = new AbortController();
  controller.abort('stop');
  await assert.rejects(() => runAgent({ model: scriptedModel([{ content: 'never' }]), signal: controller.signal }), AgentAbortError);
});

test('enforces max steps', async () => {
  const model = { async complete() { return { toolCalls: [{ id: crypto.randomUUID(), name: 'noop' }] }; } };
  const tools = new ToolRegistry().register({ name: 'noop', execute: () => 'ok' });
  await assert.rejects(() => runAgent({ model, tools, maxSteps: 2 }), MaxStepsError);
});

test('emits deterministic trace events', async () => {
  const events = [];
  await runAgent({ model: scriptedModel([{ content: 'done' }]), onEvent: e => events.push(e.type) });
  assert.deepEqual(events, ['agent.start', 'step.start', 'model.response', 'agent.complete']);
});
