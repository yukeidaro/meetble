import type { Finding, NewFinding } from "./types.js";

export function isHttpUrl(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Research log. Rejects findings without a real source URL and drops exact duplicates (same tool+url+claim). */
export class FindingStore {
  private items: Finding[] = [];
  private keys = new Set<string>();
  private seq = 0;
  private listeners: Array<(f: Finding) => void> = [];

  /** Called for every newly saved finding, as soon as it is saved (rules and live action cards hang off this). */
  onSave(fn: (f: Finding) => void): void {
    this.listeners.push(fn);
  }

  /** Returns the saved finding, or null if it was a duplicate or had no valid source_url. */
  save(f: NewFinding): Finding | null {
    if (!isHttpUrl(f.source_url)) return null;
    if (!f.claim || !f.claim.trim()) return null;
    const key = `${f.tool}|${f.source_url}|${f.claim.trim().toLowerCase()}`;
    if (this.keys.has(key)) return null;
    this.keys.add(key);
    const saved: Finding = { ...f, claim: f.claim.trim(), id: `f${++this.seq}` };
    this.items.push(saved);
    for (const fn of this.listeners) {
      try { fn(saved); } catch { /* a listener must never break a tool */ }
    }
    return saved;
  }

  all(): Finding[] {
    return [...this.items];
  }

  byTool(tool: string): Finding[] {
    return this.items.filter((f) => f.tool === tool);
  }
}
