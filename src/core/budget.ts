// Time budget for one research run. Nothing may hold the whole run hostage: each step gets
// min(its own cap, what is left of the run), and a step that runs over is reported as skipped
// while the run moves on. (Root cause #5 in the redesign doc: no run-wide budget.)

export class RunBudget {
  readonly startedAt: number;
  constructor(readonly totalMs: number, private readonly clock: () => number = Date.now) {
    this.startedAt = clock();
  }
  remainingMs(): number {
    return Math.max(0, this.totalMs - (this.clock() - this.startedAt));
  }
  elapsedS(): number {
    return Math.round((this.clock() - this.startedAt) / 1000);
  }
  /** The budget for one step: its own cap, but never past the end of the run. */
  capFor(stepCapMs: number): number {
    return Math.min(stepCapMs, this.remainingMs());
  }
}

export class OverBudget extends Error {
  constructor(readonly ms: number) {
    super(`skipped: over the time budget (${Math.round(ms / 1000)} s)`);
  }
}

/**
 * Resolves with fn()'s value, or rejects with OverBudget after ms. On expiry the signal handed to fn is aborted,
 * so HTTP calls that take it (core/http.ts requestJson) stop instead of running on in the background.
 */
export function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const ac = new AbortController();
  const onParent = () => ac.abort(parent?.reason);
  parent?.addEventListener("abort", onParent, { once: true });
  if (ms <= 0) { ac.abort(new OverBudget(0)); return Promise.reject(new OverBudget(0)); }
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { const e = new OverBudget(ms); ac.abort(e); reject(e); }, ms);
    const done = () => { clearTimeout(t); parent?.removeEventListener("abort", onParent); };
    fn(ac.signal).then((v) => { done(); resolve(v); }, (e) => { done(); reject(e); });
  });
}
