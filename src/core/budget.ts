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

/** Resolves with fn()'s value, or rejects with OverBudget after ms. fn keeps running in the background. */
export function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new OverBudget(0));
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new OverBudget(ms)), ms);
    fn().then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
