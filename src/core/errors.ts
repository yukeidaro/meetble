/** Errors carry enough context to find the root cause (which API, which status, what body). */
export class HttpError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number,
    public readonly url: string,
    public readonly bodySnippet: string,
  ) {
    super(`${service} HTTP ${status} at ${url}: ${bodySnippet.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

export class MissingKeyError extends Error {
  constructor(public readonly key: string) {
    super(`Missing ${key}. Set it in .env (see .env.example).`);
    this.name = "MissingKeyError";
  }
}

export class TimeoutError extends Error {
  constructor(public readonly service: string, public readonly ms: number) {
    super(`${service} timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

export function errorNote(e: unknown): string {
  if (e instanceof MissingKeyError) return `skipped: ${e.key} not set`;
  if (e instanceof HttpError) return `${e.service} error ${e.status}`;
  if (e instanceof TimeoutError) return `${e.service} timed out`;
  if (e instanceof Error) return e.message.slice(0, 120);
  return String(e).slice(0, 120);
}
