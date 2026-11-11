import { existsSync, readFileSync } from "node:fs";

// Tiny .env reader. Replaces process.loadEnvFile, which only exists on Node 20.12+/21.7+.
// Handles a UTF-8 BOM, CRLF line endings, # comments (full-line and after unquoted values),
// "export " prefixes, and single/double quoted values (\n escapes in double quotes).

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/;

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.replace(/^﻿/, "").split(/\r?\n|\r/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let v = m[2] ?? "";
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) {
      v = v.slice(1, v.indexOf(q, 1));
      if (q === '"') v = v.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else {
      // Unquoted: a # that starts the value or follows whitespace begins a comment.
      v = v.replace(/(^|\s)#.*$/, "").trim();
    }
    out[key] = v;
  }
  return out;
}

/** Loads `path` into `env` without overriding variables that are already set. Returns false if the file is missing. */
export function loadDotEnv(path: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!existsSync(path)) return false;
  for (const [k, v] of Object.entries(parseDotEnv(readFileSync(path, "utf8")))) {
    if (env[k] === undefined) env[k] = v;
  }
  return true;
}
