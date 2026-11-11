import { describe, expect, it } from "vitest";
import { fetchPublic, isPrivateAddress } from "../src/core/public_fetch.js";

describe("isPrivateAddress", () => {
  it("flags loopback, private, link-local/metadata, CGNAT and IPv6 local ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])
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
  it("refuses IP-literal links to private ranges", async () => {
    await expect(fetchPublic("http://[::1]/", {}, async () => new Response("ok"))).rejects.toThrow(/not a public/);
  });
});
