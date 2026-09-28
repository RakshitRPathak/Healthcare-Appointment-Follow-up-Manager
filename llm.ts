export interface LlmRequest { system: string; user: string }
export interface Llm { readonly model: string; complete(req: LlmRequest): Promise<string> }

export class LlmError extends Error {
  constructor(message: string, public retryable = true) { super(message); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenAiLlm implements Llm {
  constructor(private key: string, public model = 'gpt-4o-mini', private timeoutMs = 20_000) {}
  async complete(req: LlmRequest): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
          body: JSON.stringify({
            model: this.model, temperature: 0.2, response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
          }),
        });
        if (res.status === 429 || res.status >= 500) {
          if (attempt === 0) { await sleep(800); continue; }
          throw new LlmError(`upstream ${res.status}`, true);
        }
        if (!res.ok) throw new LlmError(`upstream ${res.status}`, false);   // 4xx: our fault, don't retry
        const text = ((await res.json()) as any).choices?.[0]?.message?.content;
        if (!text) throw new LlmError('empty completion', true);
        return text;
      } catch (e) {
        if (e instanceof LlmError) throw e;
        if (attempt === 0) { await sleep(800); continue; }            // network error / timeout
        throw new LlmError(`network or timeout: ${(e as Error).message}`, true);
      }
    }
    throw new LlmError('unreachable', true);
  }
}

/** Used when no API key is configured: every call fails, which exercises the deterministic fallback path. */
export class NullLlm implements Llm {
  model = 'none';
  async complete(): Promise<string> { throw new LlmError('LLM not configured', false); }
}
