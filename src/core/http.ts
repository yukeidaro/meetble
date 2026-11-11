import { HttpError, MissingKeyError, TimeoutError } from "./errors.js";
import type { Env, FetchLike } from "./types.js";

export function requireKey(env: Env, key: keyof Env): string {
  const v = env[key];
  if (!v || !v.trim()) throw new MissingKeyError(key);
  return v.trim();
}

export interface PostJsonOptions {
  service: string;               // "exa", "xai", "meta", "hunter"
  url: string;
  headers: Record<string, string>;
  body: unknown;
  fetch: FetchLike;
  timeoutMs?: number;            // default 30s
  retries?: number;              // retries on 429/5xx/network, default 2
  /**
   * Retry after our own timeout fired? Default true (cheap searches). Set false for long, billed
   * agentic calls: the request reached the server and is likely still running (and billed), so
   * re-sending it doubles cost and latency for an answer that will be just as slow.
   */
  retryOnTimeout?: boolean;
  signal?: AbortSignal;
  method?: "POST" | "GET";
}

/** Backoff wait that ends early (rejects) when the caller cancels. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal?.reason ?? new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * JSON request with timeout and bounded retry on 429/5xx/network errors.
 * Never retries 4xx other than 429 (those are our bugs or bad keys: surface them).
 */
export async function requestJson<T>(o: PostJsonOptions): Promise<T> {
  const retries = o.retries ?? 2;
  const timeoutMs = o.timeoutMs ?? 30_000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (o.signal?.aborted) throw o.signal.reason ?? new Error("aborted");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onOuterAbort = () => ac.abort();
    o.signal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      const res = await o.fetch(o.url, {
        method: o.method ?? "POST",
        headers: { "content-type": "application/json", ...o.headers },
        body: (o.method ?? "POST") === "GET" ? undefined : JSON.stringify(o.body),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new HttpError(o.service, res.status, o.url, text);
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          lastErr = err;
          await sleep(500 * 2 ** attempt, o.signal);
          continue;
        }
        throw err;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpError(o.service, res.status, o.url, `invalid JSON: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (o.signal?.aborted) throw e;
      const timedOut = ac.signal.aborted;
      const err = timedOut ? new TimeoutError(o.service, timeoutMs) : e;
      lastErr = err;
      if (attempt < retries && !(timedOut && o.retryOnTimeout === false)) {
        await sleep(500 * 2 ** attempt, o.signal);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
  throw lastErr;
}
