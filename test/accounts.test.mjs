import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { createAccounts, cookieValue } from "../accounts.mjs";

const CLIENT = "test-client.apps.googleusercontent.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(claims, key = privateKey, kid = "k1") {
  const data = b64({ alg: "RS256", kid, typ: "JWT" }) + "." + b64(claims);
  return data + "." + sign("RSA-SHA256", Buffer.from(data), key).toString("base64url");
}
// Google's certs endpoint, served from memory. verifyGoogle(tok) with tok = the claims object signs them first.
function setup(claims, extra = {}) {
  const fetchImpl = async () => ({ ok: true, headers: new Map([["cache-control", "max-age=60"]]), json: async () => ({ keys: [JWK] }) });
  const a = createAccounts({ dataDir: mkdtempSync(join(tmpdir(), "mb-")), clientId: CLIENT, secret: "s3cret", fetchImpl, ...extra });
  const verify = a.verifyGoogle;
  a.verifyGoogle = (tok) => verify(tok === "t" || tok === "tok" ? jwt(claims) : tok);
  return a;
}
const good = { aud: CLIENT, iss: "https://accounts.google.com", exp: String(Math.floor(Date.now() / 1000) + 600), email_verified: "true", sub: "123", email: "a@gmail.com", name: "A" };

describe("accounts", () => {
  it("verifies a Google token and creates the account once", async () => {
    const a = setup(good);
    const g = await a.verifyGoogle("tok");
    const u = a.upsert(g);
    expect(u.email).toBe("a@gmail.com");
    expect(a.upsert(g).created_at).toBe(u.created_at);
  });
  it("rejects a token for another app, unverified email, and emails outside the allow list", async () => {
    await expect(setup({ ...good, aud: "other" }).verifyGoogle("t")).rejects.toThrow(/different app/);
    await expect(setup({ ...good, email_verified: "false" }).verifyGoogle("t")).rejects.toThrow(/verified/);
    await expect(setup(good, { allow: "@example.com" }).verifyGoogle("t")).rejects.toThrow(/invite-only/);
    await expect(setup(good, { allow: "@gmail.com" }).verifyGoogle("t")).resolves.toMatchObject({ sub: "123" });
    // a domain entry needs a Workspace account of that domain, not just a matching address
    await expect(setup({ ...good, email: "b@acme.com" }, { allow: "@acme.com" }).verifyGoogle("t")).rejects.toThrow(/invite-only/);
    await expect(setup({ ...good, email: "b@acme.com", hd: "acme.com" }, { allow: "@acme.com" }).verifyGoogle("t")).resolves.toMatchObject({ email: "b@acme.com" });
  });
  it("rejects tokens not signed by Google, and expired ones", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await expect(setup(good).verifyGoogle(jwt(good, other))).rejects.toThrow(/didn't accept/);
    await expect(setup(good).verifyGoogle(jwt(good, privateKey, "unknown"))).rejects.toThrow(/didn't accept/);
    await expect(setup(good).verifyGoogle("not.a.jwt")).rejects.toThrow(/didn't accept/);
    await expect(setup({ ...good, exp: String(Math.floor(Date.now() / 1000) - 10) }).verifyGoogle("t")).rejects.toThrow(/expired/);
  });
  it("rejects a missing, non-numeric, or exactly-now expiry", async () => {
    const { exp, ...noExp } = good;
    await expect(setup(noExp).verifyGoogle("t")).rejects.toThrow(/expired/);
    await expect(setup({ ...good, exp: "soon" }).verifyGoogle("t")).rejects.toThrow(/expired/);
    await expect(setup({ ...good, exp: [4102444800] }).verifyGoogle("t")).rejects.toThrow(/expired/);
    await expect(setup({ ...good, exp: true }).verifyGoogle("t")).rejects.toThrow(/expired/);
    await expect(setup({ ...good, exp: Math.floor(Date.now() / 1000) + 600 }).verifyGoogle("t")).resolves.toMatchObject({ sub: "123" });
    const t0 = 1_800_000_000_000;
    await expect(setup({ ...good, exp: String(t0 / 1000) }, { now: () => t0 }).verifyGoogle("t")).rejects.toThrow(/expired/);
  });
  it("refreshes Google's keys for an unknown kid at most once a minute", async () => {
    let calls = 0, t = 1_800_000_000_000;
    const fetchImpl = async () => { calls++; return { ok: true, headers: new Map([["cache-control", "max-age=3600"]]), json: async () => ({ keys: [JWK] }) }; };
    const a = setup(good, { fetchImpl, now: () => t });
    const bad = () => a.verifyGoogle(jwt({ ...good, exp: String(t / 1000 + 600) }, privateKey, "nope"));
    await expect(bad()).rejects.toThrow(/didn't accept/); // initial fetch + one forced refresh
    expect(calls).toBe(2);
    for (let i = 0; i < 5; i++) await expect(bad()).rejects.toThrow(/didn't accept/);
    expect(calls).toBe(2); // cache still fresh, refresh throttled
    t += 61_000;
    await expect(bad()).rejects.toThrow(/didn't accept/);
    expect(calls).toBe(3); // rotation is still picked up after a minute
  });
  it("shares one key fetch between concurrent sign-ins, and backs off after a failure", async () => {
    let calls = 0, fail = true, t = 1_800_000_000_000;
    const fetchImpl = async () => { calls++; await new Promise((r) => setTimeout(r, 5));
      return fail ? { ok: false } : { ok: true, headers: new Map([["cache-control", "max-age=3600"]]), json: async () => ({ keys: [JWK] }) }; };
    const a = setup(good, { fetchImpl, now: () => t });
    const tok = () => a.verifyGoogle(jwt({ ...good, exp: String(t / 1000 + 600) }));
    const r = await Promise.allSettled([tok(), tok(), tok(), tok()]);
    expect(r.every((x) => x.status === "rejected" && /reach Google/.test(x.reason.message))).toBe(true);
    expect(calls).toBe(1);
    fail = false;
    await expect(tok()).rejects.toThrow(/reach Google/); // still backing off
    expect(calls).toBe(1);
    t += 11_000;
    await Promise.all([tok(), tok(), tok()]);
    expect(calls).toBe(2);
  });
  it("uses stale keys during a Google outage for at most 6 hours past expiry", async () => {
    let fail = false, t = 1_800_000_000_000;
    const fetchImpl = async () => fail ? { ok: false } : { ok: true, headers: new Map([["cache-control", "max-age=60"]]), json: async () => ({ keys: [JWK] }) };
    const a = setup(good, { fetchImpl, now: () => t });
    const tok = () => a.verifyGoogle(jwt({ ...good, exp: String(Math.floor(t / 1000) + 600) }));
    await tok(); // caches keys until t + 60 s
    fail = true;
    t += 3 * 3600_000;
    await expect(tok()).resolves.toMatchObject({ sub: "123" }); // stale but within 6 h
    t += 4 * 3600_000;
    await expect(tok()).rejects.toThrow(/reach Google/); // past the limit: 503
  });
  it("drops a session once its email leaves the allow list", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mb-"));
    const open = setup(good, { dataDir });
    open.upsert(await open.verifyGoogle("t"));
    const v = open.issue("123");
    expect(setup(good, { dataDir }).userFromCookie("mb_session=" + v)?.sub).toBe("123");
    expect(setup(good, { dataDir, allow: "someone@else.com" }).userFromCookie("mb_session=" + v)).toBeNull();
  });
  it("session cookies round-trip and can't be forged", async () => {
    const a = setup(good); a.upsert(await a.verifyGoogle("t"));
    const v = a.issue("123");
    expect(a.userFromCookie("x=1; mb_session=" + encodeURIComponent(v))?.sub).toBe("123");
    expect(a.userFromCookie("mb_session=" + v.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    expect(a.userFromCookie("mb_session=124." + v.split(".").slice(1).join("."))).toBeNull();
  });
  it("saves site sessions encrypted, never returns them, and turns them into browser cookies", async () => {
    const a = setup(good); a.upsert(await a.verifyGoogle("t"));
    const pub = a.setConnection("123", "linkedin", { url: "https://www.linkedin.com/in/a", cookie: "li_at=AQEDSECRET; JSESSIONID=x" });
    expect(JSON.stringify(pub)).not.toContain("AQEDSECRET");
    expect(pub.connections.linkedin).toMatchObject({ has_session: true, url: "https://www.linkedin.com/in/a" });
    expect(JSON.stringify(a.load("123"))).not.toContain("AQEDSECRET");
    expect(a.browserCookies(a.load("123"))).toEqual([expect.objectContaining({ name: "li_at", value: "AQEDSECRET", domain: ".linkedin.com" })]);
    expect(a.loginsFor(a.load("123")).sites.linkedin.logged_in).toBe(true);
    a.setConnection("123", "x", { handle: "@ayu" });
    expect(a.loginsFor(a.load("123")).sites.x).toMatchObject({ logged_in: false, account: "ayu" });
    a.removeConnection("123", "linkedin");
    expect(a.browserCookies(a.load("123"))).toEqual([]);
  });
  it("writes the profile in user_profile.json shape", async () => {
    const a = setup(good); a.upsert(await a.verifyGoogle("t"));
    a.setProfile("123", { role: "Founder", offer_inventory_draft: ["Intro to Taipei founders"], background: ["Ex-Microsoft"] });
    a.setConnection("123", "x", { handle: "ayu" });
    const p = a.profileJson(a.load("123"));
    expect(p).toMatchObject({ name: "A", role: "Founder", background: ["Ex-Microsoft"], offer_inventory_draft: [{ offer: "Intro to Taipei founders" }], links: { x: "ayu" } });
  });
  it("reads a cookie value from the shapes people paste", () => {
    expect(cookieValue("linkedin", "AQEDA==")).toBe("AQEDA==");
    expect(cookieValue("linkedin", "li_at=AQEDA==")).toBe("AQEDA==");
    expect(cookieValue("x", "Cookie: guest_id=1; auth_token=abc; ct0=2")).toBe("abc");
    expect(cookieValue("linkedin", '"AQE"')).toBe("AQE");
  });
});

import { publicHttpUrl } from "../server.mjs";
describe("cloud event links", () => {
  it("allows public event pages and refuses server-local destinations", () => {
    for (const ok of ["https://luma.com/compiled-poy7", "https://lu.ma/x", "http://www.eventbrite.com/e/1"]) expect(publicHttpUrl(ok)).toBe(true);
    for (const bad of ["http://127.0.0.1:8787/api", "http://localhost/", "http://169.254.169.254/latest", "http://metadata.google.internal/",
      "http://[::1]/", "http://10.0.0.5/", "file:///etc/passwd", "http://intranet/", "https://a.com:8443/", "http://user:pw@a.com/", "http://0x7f000001/"]) expect(publicHttpUrl(bad)).toBe(false);
  });
});
