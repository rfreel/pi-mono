import { ToolRegistry } from './tools.js';

export class AgentAbortError extends Error {
  constructor(message = 'agent aborted') { super(message); this.name = 'AgentAbortError'; }
}

export class MaxStepsError extends Error {
  constructor(maxSteps) { super(`agent exceeded maxSteps=${maxSteps}`); this.name = 'MaxStepsError'; this.maxSteps = maxSteps; }
}

function assertModel(model) {
  if (!model || typeof model.complete !== 'function') throw new TypeError('model.complete is required');
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new AgentAbortError(signal.reason ? String(signal.reason) : undefined);
}

function emit(onEvent, event) {
  onEvent?.(Object.freeze({ ...event }));
}

export async function runAgent({
  model,
  messages = [],
  tools = new ToolRegistry(),
  maxSteps = 16,
  signal,
  onEvent,
  context = {}
}) {
  assertModel(model);
  if (!(tools instanceof ToolRegistry)) throw new TypeError('tools must be a ToolRegistry');
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new RangeError('maxSteps must be a positive integer');

  const history = structuredClone(messages);
  emit(onEvent, { type: 'agent.start', messageCount: history.length });

  for (let step = 0; step < maxSteps; step++) {
    assertNotAborted(signal);
    emit(onEvent, { type: 'step.start', step });

    const response = await model.complete({
      messages: structuredClone(history),
      tools: tools.list(),
      signal,
      context
    });

    assertNotAborted(signal);
    if (!response || typeof response !== 'object') throw new TypeError('model returned invalid response');

    const assistant = {
      role: 'assistant',
      content: typeof response.content === 'string' ? response.content : '',
      toolCalls: Array.isArray(response.toolCalls) ? structuredClone(response.toolCalls) : []
    };
    history.push(assistant);
    emit(onEvent, { type: 'model.response', step, content: assistant.content, toolCallCount: assistant.toolCalls.length });

    if (assistant.toolCalls.length === 0) {
      emit(onEvent, { type: 'agent.complete', step, content: assistant.content });
      return { content: assistant.content, messages: history, steps: step + 1 };
    }

    for (const call of assistant.toolCalls) {
      assertNotAborted(signal);
      const tool = tools.get(call.name);
      emit(onEvent, { type: 'tool.start', step, callId: call.id, name: call.name });

      let toolMessage;
      if (!tool) {
        toolMessage = { role: 'tool', toolCallId: call.id, name: call.name, ok: false, content: `unknown tool: ${call.name}` };
        emit(onEvent, { type: 'tool.error', step, callId: call.id, name: call.name, error: toolMessage.content });
      } else {
        try {
          const value = await tool.execute(call.input ?? {}, { signal, context, messages: structuredClone(history) });
          assertNotAborted(signal);
          toolMessage = { role: 'tool', toolCallId: call.id, name: call.name, ok: true, content: typeof value === 'string' ? value : JSON.stringify(value) };
          emit(onEvent, { type: 'tool.complete', step, callId: call.id, name: call.name, content: toolMessage.content });
        } catch (error) {
          if (signal?.aborted) throw new AgentAbortError(signal.reason ? String(signal.reason) : undefined);
          const message = error instanceof Error ? error.message : String(error);
          toolMessage = { role: 'tool', toolCallId: call.id, name: call.name, ok: false, content: message };
          emit(onEvent, { type: 'tool.error', step, callId: call.id, name: call.name, error: message });
        }
      }
      history.push(toolMessage);
    }
  }

  emit(onEvent, { type: 'agent.max_steps', maxSteps });
  throw new MaxStepsError(maxSteps);
}
