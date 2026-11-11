// Meetble accounts (cloud mode): Google sign-in, one record per person, and their saved site connections.
// Zero dependencies. Turned on by GOOGLE_CLIENT_ID; without it server.mjs stays the single-user local app.
//
// Storage: one JSON file per account in $MEETBLE_DATA/users/<google sub>.json (on Cloud Run, a Cloud Storage
// bucket mounted at /data). Session cookies for LinkedIn / X / Luma / Instagram are encrypted at rest with
// AES-256-GCM, keyed from MEETBLE_SECRET, and never sent back to the browser.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SITES = {
  linkedin: { name: "LinkedIn", cookie: "li_at", domain: ".linkedin.com", hint: "linkedin.com/in/your-name" },
  x: { name: "X", cookie: "auth_token", domain: ".x.com", hint: "@handle" },
  luma: { name: "Luma", cookie: "luma.auth-session-key", domain: ".luma.com", hint: "luma.com/user/you" },
  instagram: { name: "Instagram", cookie: "sessionid", domain: ".instagram.com", hint: "@handle" },
};
const PROFILE_KEYS = ["name", "role", "location", "company", "background", "looking_for", "offer_inventory_draft", "links"];
const SESSION_DAYS = 30;

export function createAccounts({ dataDir, clientId, secret, allow = "", fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    console.warn("MEETBLE_SECRET is not set: sessions and saved site cookies won't survive a restart.");
  }
  const usersDir = join(dataDir, "users");
  mkdirSync(usersDir, { recursive: true });
  const encKey = createHash("sha256").update("meetble-connections:" + secret).digest();
  const macKey = createHash("sha256").update("meetble-session:" + secret).digest();
  const allowList = String(allow).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  const fileOf = (sub) => join(usersDir, String(sub).replace(/[^0-9A-Za-z_-]/g, "") + ".json");
  const load = (sub) => { const f = fileOf(sub); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };
  const save = (u) => { const f = fileOf(u.sub); writeFileSync(f + ".tmp", JSON.stringify(u, null, 2)); renameSync(f + ".tmp", f); return u; };

  const seal = (text) => {
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", encKey, iv);
    const body = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
    return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
  };
  const open = (sealed) => {
    try {
      const [iv, tag, body] = String(sealed).split(".").map((s) => Buffer.from(s, "base64url"));
      const d = createDecipheriv("aes-256-gcm", encKey, iv); d.setAuthTag(tag);
      return Buffer.concat([d.update(body), d.final()]).toString("utf8");
    } catch { return null; }
  };

  // ---------- Google sign-in ----------
  function allowed(email) {
    if (!allowList.length) return true;
    const e = email.toLowerCase();
    return allowList.some((a) => (a.startsWith("@") ? e.endsWith(a) : e === a));
  }
  /** Verify a Google Identity Services ID token (the "credential" the Sign in with Google button returns). */
  async function verifyGoogle(credential) {
    if (!credential || typeof credential !== "string") throw httpError(400, "missing credential");
    const r = await fetchImpl("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
    const t = await r.json().catch(() => ({}));
    if (!r.ok || t.error) throw httpError(401, "Google didn't accept that sign-in");
    if (t.aud !== clientId) throw httpError(401, "sign-in was for a different app");
    if (!["accounts.google.com", "https://accounts.google.com"].includes(t.iss)) throw httpError(401, "bad issuer");
    if (Number(t.exp) * 1000 < now()) throw httpError(401, "sign-in expired, try again");
    if (String(t.email_verified) !== "true") throw httpError(401, "Google email isn't verified");
    if (!allowed(t.email)) throw httpError(403, "This Meetble is invite-only. Ask the owner to add " + t.email);
    return { sub: String(t.sub), email: t.email, name: t.name || t.email, picture: t.picture || "" };
  }
  /** First sign-in creates the account; later sign-ins refresh name/picture. */
  function upsert(g) {
    const u = load(g.sub) || { sub: g.sub, created_at: new Date(now()).toISOString(), connections: {}, profile: {} };
    Object.assign(u, { email: g.email, name: g.name, picture: g.picture, last_login_at: new Date(now()).toISOString() });
    if (!u.profile?.name) u.profile = { ...(u.profile || {}), name: g.name };
    return save(u);
  }

  // ---------- sessions: "sub.expiry.hmac" in an HttpOnly cookie ----------
  const mac = (s) => createHmac("sha256", macKey).update(s).digest("base64url");
  function issue(sub) {
    const exp = Math.floor(now() / 1000) + SESSION_DAYS * 86400, v = `${sub}.${exp}`;
    return `${v}.${mac(v)}`;
  }
  function userFromCookie(header) {
    const m = String(header || "").match(/(?:^|;\s*)mb_session=([^;]+)/);
    if (!m) return null;
    const [sub, exp, sig] = decodeURIComponent(m[1]).split(".");
    if (!sub || !exp || !sig) return null;
    const want = Buffer.from(mac(`${sub}.${exp}`)), got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    if (Number(exp) * 1000 < now()) return null;
    return load(sub);
  }
  const cookieHeader = (value, secure, maxAge = SESSION_DAYS * 86400) =>
    `mb_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  // ---------- connections ----------
  function setConnection(sub, site, body = {}) {
    if (!SITES[site]) throw httpError(404, "unknown site " + site);
    const u = load(sub); if (!u) throw httpError(401, "sign in first");
    const prev = u.connections?.[site] || {};
    const c = { ...prev, saved_at: new Date(now()).toISOString() };
    if (body.url !== undefined) c.url = String(body.url).trim().slice(0, 300);
    if (body.handle !== undefined) c.handle = String(body.handle).trim().replace(/^@/, "").slice(0, 80);
    if (body.cookie !== undefined) {
      const v = cookieValue(site, body.cookie);
      if (v) c.cookie = seal(v); else delete c.cookie;
    }
    u.connections = { ...(u.connections || {}), [site]: c };
    save(u);
    return publicUser(u);
  }
  function removeConnection(sub, site) {
    const u = load(sub); if (!u) throw httpError(401, "sign in first");
    if (u.connections) delete u.connections[site];
    save(u);
    return publicUser(u);
  }
  function setProfile(sub, body = {}) {
    const u = load(sub); if (!u) throw httpError(401, "sign in first");
    const p = {};
    for (const k of PROFILE_KEYS) if (body[k] !== undefined) p[k] = body[k];
    u.profile = { ...(u.profile || {}), ...p };
    save(u);
    return publicUser(u);
  }
  /** The person's profile in the shape plan/ and src/cli.ts read as user_profile.json. */
  function profileJson(u) {
    const p = { ...(u.profile || {}) };
    const lines = (v) => (Array.isArray(v) ? v : String(v || "").split(/\n+/)).map((s) => String(s).trim()).filter(Boolean);
    for (const k of ["background", "looking_for"]) if (p[k] !== undefined) p[k] = lines(p[k]);
    if (p.offer_inventory_draft !== undefined) p.offer_inventory_draft = (Array.isArray(p.offer_inventory_draft) ? p.offer_inventory_draft : lines(p.offer_inventory_draft))
      .map((o) => (typeof o === "string" ? { offer: o } : o)).filter((o) => o && (o.offer || typeof o === "object"));
    if (typeof p.company === "string") p.company = { one_liner: p.company };
    const links = { ...(p.links || {}) };
    for (const [site, c] of Object.entries(u.connections || {})) if (c.url || c.handle) links[site] = c.url || c.handle;
    p.links = links;
    p._source = "Meetble account " + u.email;
    return p;
  }
  /** CDP Network.setCookies params for this person's saved sessions, so a server-side Chrome is signed in as them. */
  function browserCookies(u) {
    const out = [];
    for (const [site, c] of Object.entries(u.connections || {})) {
      const v = c.cookie && open(c.cookie), s = SITES[site];
      if (!v || !s) continue;
      const base = { name: s.cookie, value: v, path: "/", secure: true, httpOnly: true, sameSite: "None", expires: Math.floor(now() / 1000) + 30 * 86400 };
      out.push({ ...base, domain: s.domain });
      if (site === "x") out.push({ ...base, domain: ".twitter.com" });
      if (site === "luma") out.push({ ...base, domain: ".lu.ma" });
    }
    return out;
  }
  /** Same shape as server.mjs /api/logins, so the account cards work unchanged. */
  function loginsFor(u) {
    const sites = {};
    for (const site of Object.keys(SITES)) {
      const c = u.connections?.[site] || {};
      sites[site] = { logged_in: !!c.cookie, account: c.handle || c.url || "", saved: !!(c.url || c.handle) };
    }
    return { sites, signed_out: Object.keys(sites).filter((s) => !sites[s].logged_in), method: "account" };
  }
  function publicUser(u) {
    const connections = {};
    for (const site of Object.keys(SITES)) {
      const c = u.connections?.[site];
      connections[site] = c ? { url: c.url || "", handle: c.handle || "", has_session: !!c.cookie, saved_at: c.saved_at } : null;
    }
    return { email: u.email, name: u.name, picture: u.picture, created_at: u.created_at, profile: u.profile || {}, connections, sites: SITES };
  }

  return { verifyGoogle, upsert, issue, userFromCookie, cookieHeader, setConnection, removeConnection, setProfile, profileJson, browserCookies, loginsFor, publicUser, load, seal, open };
}

/** Accept the bare cookie value, "li_at=AQE...", or a whole "Cookie:" header pasted from DevTools. */
export function cookieValue(site, raw) {
  const s = String(raw || "").trim().replace(/^cookie:\s*/i, "");
  if (!s) return "";
  const name = SITES[site]?.cookie;
  if (name && s.includes("=")) {
    const hit = s.split(/;\s*/).map((p) => p.split("=")).find(([k]) => k.trim() === name);
    if (hit) return hit.slice(1).join("=").trim().replace(/^"|"$/g, "");
  }
  return s.replace(/^"|"$/g, "");
}

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }
