import type { JevResponse, JevTransport } from "./types.js";

export interface JevConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  timeoutMs: number;
  retries: number;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.min(2000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Jev request aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class FetchJevTransport implements JevTransport {
  constructor(
    private readonly config: JevConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async decide(
    request: { model: string; state: unknown; questions: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<JevResponse> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.config.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            "content-type": "application/json",
            ...this.config.headers,
          },
          body: JSON.stringify({ ...request, model: request.model || this.config.model }),
          signal: combineSignals(signal, this.config.timeoutMs),
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? new Error("Jev request aborted");
        lastError = new Error(
          `Jev request attempt ${attempt + 1} failed or timed out: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (attempt < this.config.retries) {
          await backoff(attempt, signal);
          continue;
        }
        throw lastError;
      }
      const text = await response.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        lastError = new Error(`Jev endpoint returned invalid JSON (${response.status})`);
        if (attempt < this.config.retries && retryableStatus(response.status)) {
          await backoff(attempt, signal);
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        lastError = new Error(`Jev endpoint ${response.status}: ${body?.error?.message ?? text.slice(0, 240)}`);
        if (attempt < this.config.retries && retryableStatus(response.status)) {
          await backoff(attempt, signal);
          continue;
        }
        throw lastError;
      }
      if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object")
        throw new Error("Jev endpoint returned no answers object");
      return body as JevResponse;
    }
    throw lastError ?? new Error("Jev request failed");
  }
}
