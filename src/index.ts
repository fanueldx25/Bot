#!/usr/bin/env node
import path from 'node:path';
import { OpenAIClient } from './ai.js';
import { Engine } from './engine.js';
import { createTools } from './tools.js';
import { FsWorkspace } from './workspace.js';
import type { EngineEvent } from './types.js';

const PHASE_COLOR: Record<string, string> = {
  EXPLORE:  '\x1b[36m', // cyan
  PLAN:     '\x1b[35m', // magenta
  EDIT:     '\x1b[33m', // yellow
  VERIFY:   '\x1b[34m', // blue
  RECOVER:  '\x1b[31m', // red
  COMPLETE: '\x1b[32m', // green
};
const R = '\x1b[0m', DIM = '\x1b[2m', BOLD = '\x1b[1m';

function tag(e: EngineEvent): string {
  const c = PHASE_COLOR[e.phase] ?? '';
  return `${c}${e.phase.padEnd(8)}${R}`;
}

function render(e: EngineEvent) {
  switch (e.type) {
    case 'enter':
      console.log(`\n${tag(e)} ${BOLD}─── entering ${e.phase} ───${R}`);
      break;
    case 'think':
      console.log(`${tag(e)} 💭 ${e.payload}`);
      break;
    case 'tool': {
      const p: any = e.payload;
      console.log(`${tag(e)} 🔧 ${p.tool}(${clip(JSON.stringify(p.args ?? {}), 120)})`);
      break;
    }
    case 'observation': {
      const p: any = e.payload;
      const ok = p.ok ?? true;
      console.log(`${tag(e)}    ${ok ? '↳' : '✗'} ${clip(String(p.output ?? ''), 240).replace(/\n/g, '\n            ')}`);
      break;
    }
    case 'plan': {
      console.log(`${tag(e)} 📋 plan:`);
      for (const s of e.payload as any[]) console.log(`            ${s.id}. ${s.description}`);
      break;
    }
    case 'verify': {
      const p: any = e.payload;
      console.log(`${tag(e)} ${p.ok ? '✓' : '✗'} ${p.name}: ${clip(p.output, 200).replace(/\n/g, '\n            ')}`);
      break;
    }
    case 'recover': {
      const p: any = e.payload;
      console.log(`${tag(e)} 🩹 strategy=${p.strategy} — ${clip(p.reasoning, 200)}`);
      break;
    }
    case 'guard': {
      const p: any = e.payload;
      console.log(`${tag(e)} 🛡  BLOCKED transition → ${p.blocked} (allowed: ${p.allowed.join(', ')})`);
      break;
    }
    case 'exit':
      break;
    case 'done': {
      const p: any = e.payload;
      console.log(`\n${p.ok ? '✅' : '❌'} ${p.summary}`);
      break;
    }
  }
}

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n) + '…');

async function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  const i = args.indexOf('--root');
  if (i >= 0) { root = path.resolve(args[i + 1]); args.splice(i, 2); }
  const task = args.join(' ').trim();

  if (!task) {
    console.error(`orbit — six-phase coding engine

Usage:
  orbit --root <dir> "<task>"

Env:
  AI_BASE_URL, AI_API_KEY, AI_MODEL
`);
    process.exit(1);
  }

  const ai = new OpenAIClient();
  const workspace = new FsWorkspace(root);
  const tools = createTools();

  const engine = new Engine({ ai, workspace, tools, onEvent: render });

  console.log(`${BOLD}orbit${R}  model=${ai.model}  root=${root}`);
  console.log(`${DIM}EXPLORE → PLAN → EDIT → VERIFY → RECOVER → COMPLETE${R}`);

  const result = await engine.run(task);

  console.log(`\n${DIM}elapsed ${(result.elapsedMs / 1000).toFixed(1)}s · final phase ${result.finalPhase}${R}`);
  if (!result.ok) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });