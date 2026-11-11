import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FetchLike } from "./types.js";

/** True for loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    // Anything starting "::" is unspecified, loopback, or IPv4-mapped/compatible in any spelling (::ffff:127.0.0.1, ::ffff:7f00:1): refuse them all.
    return x.startsWith("::") || /^0{1,4}:/.test(x) || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith("64:ff9b:") || x.startsWith("2001:db8:");
  }
  return true; // not an IP at all
}

type Resolve = (host: string) => Promise<string[]>;

/** Reject as soon as the signal aborts, even while `p` (e.g. a DNS lookup) is still pending. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return p;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
const resolveAll: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Fetch a URL someone typed in, refusing any hop (the URL itself and every redirect) whose host resolves to a non-public address.
 * Used for event links in cloud mode (MEETBLE_PUBLIC_LINKS_ONLY=1). Note: DNS is checked just before connecting, so a host that
 * changes its answer between the check and the connection (DNS rebinding) is only covered when fetchImpl is pinnedFetch.
 */
export async function fetchPublic(url: string, init: RequestInit, fetchImpl: FetchLike, resolve: Resolve = resolveAll, maxRedirects = 5): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error("blocked: not a public http(s) link");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    init.signal?.throwIfAborted();
    const addrs = isIP(host) ? [host] : await abortable(resolve(host), init.signal);
    if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error(`blocked: ${host} is not a public address`);
    const res = await fetchImpl(current, { ...init, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    current = new URL(loc, current).toString();
  }
  throw new Error("blocked: too many redirects");
}

/**
 * A minimal GET over node:http(s) whose connect-time DNS lookup refuses non-public addresses, so the address that is
 * checked is the one connected to (closes DNS rebinding). Redirects are returned, not followed: fetchPublic follows them.
 */
export const pinnedFetch: FetchLike = async (input, init = {}) => {
  const { request: httpRequest } = await import("node:http");
  const { request: httpsRequest } = await import("node:https");
  const { lookup: dnsLookup } = await import("node:dns");
  const u = new URL(input);
  const guardedLookup = (host: string, opts: object, cb: (err: Error | null, address?: unknown, family?: number) => void) =>
    dnsLookup(host, { ...opts, all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = addrs as { address: string; family: number }[];
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad || !list.length) return cb(new Error(`blocked: ${host} is not a public address`));
      (opts as { all?: boolean }).all ? cb(null, list) : cb(null, list[0]!.address, list[0]!.family);
    });
  const headers = Object.fromEntries(new Headers(init.headers as HeadersInit | undefined).entries());
  init.signal?.throwIfAborted();
  return await new Promise<Response>((resolve, reject) => {
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, { method: init.method || "GET", headers, lookup: guardedLookup as never, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size > 5_000_000) { req.destroy(new Error("page too large")); return; } chunks.push(c); });
      res.on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        const status = res.statusCode || 500;
        try { resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: h })); }
        catch (e) { reject(e); } // e.g. a status Response() refuses (600): fail this page, not the whole run
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
};
