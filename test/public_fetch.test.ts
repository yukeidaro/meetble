import { describe, expect, it } from "vitest";
import { fetchPublic, isPrivateAddress } from "../src/core/public_fetch.js";

describe("isPrivateAddress", () => {
  it("flags loopback, private, link-local/metadata, CGNAT and IPv6 local ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:7f00:1", "::7f00:1"])
      expect(isPrivateAddress(ip), ip).toBe(true);
  });
  it("passes public addresses", () => {
    for (const ip of ["8.8.8.8", "104.18.1.1", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("fetchPublic", () => {
  const dns = (map: Record<string, string>) => async (h: string) => (map[h] ? [map[h]] : []);
  it("fetches a public host", async () => {
    const r = await fetchPublic("https://luma.com/x", {}, async () => new Response("ok"), dns({ "luma.com": "104.18.1.1" }));
    expect(await r.text()).toBe("ok");
  });
  it("refuses a host that resolves to a private address", async () => {
    await expect(fetchPublic("https://evil.example/x", {}, async () => new Response("ok"), dns({ "evil.example": "169.254.169.254" }))).rejects.toThrow(/not a public/);
  });
  it("checks every redirect hop", async () => {
    const f = async (u: string) => u.includes("luma.com") ? new Response(null, { status: 302, headers: { location: "http://internal.example/" } }) : new Response("secret");
    await expect(fetchPublic("https://luma.com/x", {}, f, dns({ "luma.com": "104.18.1.1", "internal.example": "10.0.0.5" }))).rejects.toThrow(/not a public/);
  });
  it("refuses a redirect to a hex IPv4-mapped loopback", async () => {
    const f = async (u: string) => u.includes("luma.com") ? new Response(null, { status: 301, headers: { location: "http://[::ffff:7f00:1]/" } }) : new Response("secret");
    await expect(fetchPublic("https://luma.com/x", {}, f, dns({ "luma.com": "104.18.1.1" }))).rejects.toThrow(/not a public/);
  });
  it("stops waiting on DNS when the deadline passes", async () => {
    const ac = new AbortController();
    const never = () => new Promise<string[]>(() => {});
    const p = fetchPublic("https://slow.example/", { signal: ac.signal }, async () => new Response("ok"), never);
    ac.abort(new Error("deadline"));
    await expect(p).rejects.toThrow(/deadline/);
  });
  it("refuses IP-literal links to private ranges", async () => {
    await expect(fetchPublic("http://[::1]/", {}, async () => new Response("ok"))).rejects.toThrow(/not a public/);
  });
});

describe("pinnedFetch", () => {
  it("refuses to connect to a host that resolves to loopback", async () => {
    const { pinnedFetch } = await import("../src/core/public_fetch.js");
    await expect(pinnedFetch("http://localhost:9/")).rejects.toThrow(/not a public/);
  });
  it("DNS rebinding: a host that passes the pre-check but resolves privately at connect time is refused", async () => {
    const { pinnedFetch } = await import("../src/core/public_fetch.js");
    const firstAnswerPublic = async () => ["8.8.8.8"]; // what the pre-check sees; the connect-time lookup then gets 127.0.0.1
    await expect(fetchPublic("http://localhost:9/", {}, pinnedFetch, firstAnswerPublic)).rejects.toThrow(/not a public/);
  });
  it("turns a status Response() refuses into a rejection", async () => {
    const { createServer } = await import("node:net");
    const { pinnedFetch } = await import("../src/core/public_fetch.js");
    const srv = createServer((s) => s.end("HTTP/1.1 600 Weird\r\ncontent-length: 0\r\n\r\n"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    // 127.0.0.1 is an IP literal (no lookup), so the guard isn't in play here: this checks only the status handling.
    await expect(pinnedFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    srv.close();
  });
});
