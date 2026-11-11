// A headless Chrome for one run on the server, signed in with the person's saved site sessions.
// browser_tools.py attaches to it through MEETBLE_CDP_URL, exactly as it attaches to your own Chrome locally.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function chromePath(env = process.env) {
  if (env.CHROME_PATH) return env.CHROME_PATH;
  return ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/opt/pw-browsers/chromium"].find((p) => existsSync(p)) || null;
}

/** Start Chrome, set the cookies, and return { url, close }. Throws when no Chrome binary is installed. */
export async function launchSignedInChrome(cookies, { env = process.env, timeoutMs = 20_000 } = {}) {
  const bin = chromePath(env);
  if (!bin) throw new Error("no Chrome on this server (set CHROME_PATH)");
  const dir = mkdtempSync(join(tmpdir(), "meetble-chrome-"));
  const p = spawn(bin, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--window-size=1280,900", "about:blank"],
  // A minimal env: the server's API keys and MEETBLE_SECRET never reach the browser process.
  { stdio: ["ignore", "ignore", "pipe"], env: { PATH: env.PATH || "/usr/bin:/bin", HOME: dir, TMPDIR: dir, LANG: env.LANG || "C.UTF-8" } });
  const close = () => { try { p.kill("SIGKILL"); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  try {
    const url = await new Promise((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error("Chrome didn't start in time")), timeoutMs);
      p.stderr.setEncoding("utf8");
      p.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
      p.on("error", (e) => { clearTimeout(t); reject(new Error("couldn't start Chrome: " + e.message)); });
      p.on("exit", (code) => { clearTimeout(t); reject(new Error(`Chrome exited (${code}): ${buf.trim().split("\n").pop() || ""}`)); });
    });
    if (cookies.length) await cdpCall(url, "Storage.setCookies", { cookies });
    return { url, close };
  } catch (e) { close(); throw e; }
}

function cdpCall(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { reject(new Error("Chrome did not answer")); try { ws.close(); } catch {} }, 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onerror = () => { clearTimeout(t); reject(new Error("couldn't reach Chrome")); };
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id !== 1) return;
      clearTimeout(t); ws.close();
      d.error ? reject(new Error(d.error.message)) : resolve(d.result);
    };
  });
}
