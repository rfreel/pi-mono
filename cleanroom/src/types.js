export const Role = Object.freeze({ USER: 'user', ASSISTANT: 'assistant', TOOL: 'tool' });

export function textMessage(role, content) {
  if (!Object.values(Role).includes(role)) throw new TypeError(`invalid role: ${role}`);
  if (typeof content !== 'string') throw new TypeError('content must be a string');
  return { role, content };
}

export function toolCall(id, name, input = {}) {
  if (!id || !name) throw new TypeError('tool call requires id and name');
  return { id, name, input };
}
