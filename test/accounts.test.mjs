import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccounts, cookieValue } from "../accounts.mjs";

const CLIENT = "test-client.apps.googleusercontent.com";
function setup(token, extra = {}) {
  const fetchImpl = async () => ({ ok: !token.error, json: async () => token });
  return createAccounts({ dataDir: mkdtempSync(join(tmpdir(), "mb-")), clientId: CLIENT, secret: "s3cret", fetchImpl, ...extra });
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
