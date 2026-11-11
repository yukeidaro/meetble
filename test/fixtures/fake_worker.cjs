// Stands in for `python browser_tools.py ...` in tests: same CLI and the same serve protocol, no browser.
const { createServer } = require("node:net");
const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "serve") { console.log(JSON.stringify({ oneshot: cmd, args: rest })); process.exit(0); }
if (process.env.FAKE_NO_SERVE) { console.error("invalid choice: 'serve'"); process.exit(2); }
const token = process.env.MEETBLE_WORKER_TOKEN;
let conns = 0;
const srv = createServer((s) => {
  conns++;
  let buf = "";
  s.setEncoding("utf8");
  s.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.token !== token) { s.write(JSON.stringify({ id: m.id, result: { error: "bad token" } }) + "\n"); continue; }
      if ("cancel" in m) { cancelled.push(m.cancel); continue; }
      if (m.cmd === "slow") continue; // never answers unless cancelled
      if (m.cmd === "stats") { s.write(JSON.stringify({ id: m.id, result: { conns, cancelled } }) + "\n"); continue; }
      s.write(JSON.stringify({ id: m.id, result: { cmd: m.cmd, args: m.args, pid: process.pid } }) + "\n");
    }
  });
});
const cancelled = [];
srv.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ listening: srv.address().port })));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
