import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolRegistry } from './types.js';

const run = promisify(execFile);
const isWin = process.platform === 'win32';

class Registry implements ToolRegistry {
  private map = new Map<string, Tool>();
  register(t: Tool) { this.map.set(t.name, t); return this; }
  has(name: string) { return this.map.has(name); }
  describe() {
    return [...this.map.values()]
      .map(t => `- ${t.name}(${Object.keys(t.parameters.properties).join(', ')}): ${t.description}`)
      .join('\n');
  }
  async call(name: string, args: any, ctx: { workspace: any }) {
    const t = this.map.get(name);
    if (!t) return { ok: false, output: `Unknown tool: ${name}` };
    try { return await t.run(args ?? {}, ctx); }
    catch (e) { return { ok: false, output: `Tool ${name} threw: ${(e as Error).message}` }; }
  }
}

export function createTools(): ToolRegistry {
  const r = new Registry();

  r.register({
    name: 'read_file',
    description: 'Read a UTF-8 file relative to the workspace root.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run({ path }, { workspace }) {
      return { ok: true, output: await workspace.read(path) };
    },
  });

  r.register({
    name: 'write_file',
    description: 'Create or overwrite a file. Provide the FULL file content, not a diff.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async run({ path, content }, { workspace }) {
      await workspace.write(path, content);
      return { ok: true, output: `wrote ${content.length} chars to ${path}` };
    },
  });

  r.register({
    name: 'list_files',
    description: 'List source files (.ts/.tsx/.js/.json) in the workspace.',
    parameters: { type: 'object', properties: {} },
    async run(_a, { workspace }) {
      const files: string[] = await workspace.list();
      return { ok: true, output: files.join('\n') || '(empty)' };
    },
  });

  r.register({
    name: 'run_command',
    description: 'Run a shell command in the workspace root. Use for tests, builds, greps.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
      },
      required: ['command'],
    },
    async run({ command, args = [] }, { workspace }) {
      try {
        const { stdout, stderr } = await run(command, args, {
          cwd: workspace.root, timeout: 90_000, shell: isWin,
          maxBuffer: 8 * 1024 * 1024,
        });
        return { ok: true, output: ((stdout ?? '') + (stderr ?? '')).slice(0, 6000) || '(no output)' };
      } catch (e: any) {
        const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 6000);
        return { ok: false, output: `exit ${e.code ?? '?'}\n${out || e.message}` };
      }
    },
  });

  return r;
}