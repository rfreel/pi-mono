export class ToolRegistry {
  #tools = new Map();

  register(tool) {
    if (!tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function') {
      throw new TypeError('tool requires name and execute');
    }
    if (this.#tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.#tools.set(tool.name, tool);
    return this;
  }

  get(name) { return this.#tools.get(name); }
  has(name) { return this.#tools.has(name); }
  list() { return [...this.#tools.values()].map(({ name, description = '', inputSchema = null }) => ({ name, description, inputSchema })); }
}
