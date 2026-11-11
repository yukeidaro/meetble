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
    const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m?.[1]) return isPrivateAddress(m[1]);
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith("64:ff9b:") || x.startsWith("2001:db8:");
  }
  return true; // not an IP at all
}

type Resolve = (host: string) => Promise<string[]>;
const resolveAll: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Fetch a URL someone typed in, refusing any hop (the URL itself and every redirect) whose host resolves to a non-public address.
 * Used for event links in cloud mode (MEETBLE_PUBLIC_LINKS_ONLY=1). Note: DNS is checked just before connecting, so a host that
 * changes its answer between the check and the connection (DNS rebinding) is not covered.
 */
export async function fetchPublic(url: string, init: RequestInit, fetchImpl: FetchLike, resolve: Resolve = resolveAll, maxRedirects = 5): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error("blocked: not a public http(s) link");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [host] : await resolve(host);
    if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error(`blocked: ${host} is not a public address`);
    const res = await fetchImpl(current, { ...init, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    current = new URL(loc, current).toString();
  }
  throw new Error("blocked: too many redirects");
}
