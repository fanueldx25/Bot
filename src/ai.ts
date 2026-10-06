import type { AIClient, Message } from './types.js';

export class OpenAIClient implements AIClient {
  model: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(opts: { baseUrl?: string; apiKey?: string; model?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.AI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey  = opts.apiKey  ?? process.env.AI_API_KEY ?? '';
    this.model   = opts.model   ?? process.env.AI_MODEL   ?? 'gpt-4o-mini';
  }

  async complete(messages: Message[]): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, temperature: 0.1, messages }),
    });
    if (!res.ok) throw new Error(`AI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  async json<T>(messages: Message[], shapeHint: string): Promise<T> {
    const text = await this.complete([
      ...messages,
      {
        role: 'system',
        content:
          'Reply with a single valid JSON object and nothing else. ' +
          'No markdown fences, no prose. Shape: ' + shapeHint,
      },
    ]);
    return parseJson<T>(text);
  }
}

function parseJson<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // last-ditch: grab first {...} block
    const m = candidate.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error(`Non-JSON from model: ${raw.slice(0, 200)}`);
  }
}