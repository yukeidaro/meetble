import { errorNote } from "./errors.js";
import type { ToolContext } from "./types.js";

/**
 * Runs one checklist step: emits "running", then "done" with the note from `summarize`,
 * or "error"/"skipped" with a short reason. Never throws: one failing tool must not stop the run.
 */
export async function runStep<T>(
  ctx: ToolContext,
  id: string,
  label: string,
  fn: () => Promise<T>,
  summarize: (r: T) => string,
): Promise<T | undefined> {
  ctx.emit({ id, label, status: "running", at: ctx.now().toISOString() });
  try {
    const r = await fn();
    // Tools report "nothing to do" as a value ({skipped: true, reason}); show it as skipped, not done.
    const sk = r as unknown as { skipped?: unknown; reason?: unknown } | undefined;
    if (sk && typeof sk === "object" && sk.skipped === true) {
      const reason = typeof sk.reason === "string" && sk.reason ? sk.reason : summarize(r);
      ctx.emit({ id, label, status: "skipped", note: reason.startsWith("skipped") ? reason : `skipped: ${reason}`, at: ctx.now().toISOString() });
      return r;
    }
    ctx.emit({ id, label, status: "done", note: summarize(r), at: ctx.now().toISOString() });
    return r;
  } catch (e) {
    const note = errorNote(e);
    const status = note.startsWith("skipped") ? "skipped" : "error";
    ctx.emit({ id, label, status, note, at: ctx.now().toISOString() });
    return undefined;
  }
}
