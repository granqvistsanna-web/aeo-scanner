import { analyze } from "./analyze.js";

const UA = "Mozilla/5.0 (compatible; AEO-Scanner/1.0; +https://granqvistsanna-web.github.io/aeo-scanner/)";
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 10_000;
// robots.txt, llms.txt and sitemaps get less time, so a full scan stays under ~20 s.
const SIDE_TIMEOUT_MS = 5_000;

export class ScanError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) throw new ScanError("Enter a URL to scan.");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new ScanError("That doesn't look like a valid URL.");
  }
  assertPublicHost(u);
  u.hash = "";
  return u;
}

function assertPublicHost(u) {
  if (!/^https?:$/.test(u.protocol)) throw new ScanError("Only http and https URLs can be scanned.");
  if (u.username || u.password) throw new ScanError("URLs with credentials can't be scanned.");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateV4 = /^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
  if (
    !h.includes(".") && !h.includes(":") ||
    /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(h) ||
    privateV4.test(h) ||
    /^\d+$/.test(h) ||
    /^(::|::1|f[cd][0-9a-f]{2}:|fe80:)/.test(h) ||
    h.startsWith("::ffff:")
  )
    throw new ScanError("Only public websites can be scanned.");
}

async function readCapped(res, max = MAX_BYTES) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    buf.set(c.subarray(0, buf.length - off), off);
    off += c.byteLength;
    if (off >= buf.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

// Follows redirects by hand so every hop is checked against private hosts.
async function get(url, { accept = "text/html,*/*;q=0.8", timeout = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  let current = new URL(url);
  const deadline = AbortSignal.timeout(timeout);
  for (let hop = 0; hop < 6; hop++) {
    assertPublicHost(current);
    const res = await fetch(current, {
      redirect: "manual",
      signal: deadline,
      headers: { "user-agent": UA, accept, "accept-language": "en,sv;q=0.8" },
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      current = new URL(loc, current);
      continue;
    }
    const headers = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const text = await readCapped(res, maxBytes);
    return { url: current.href, status: res.status, headers, text };
  }
  throw new ScanError("Too many redirects.", 502);
}

const soft = (p) => p.catch(() => null);

export async function scan(rawUrl) {
  const target = normalizeUrl(rawUrl);

  const t0 = performance.now();
  let page;
  try {
    page = await get(target.href);
  } catch (e) {
    if (e instanceof ScanError) throw e;
    const msg = e?.name === "TimeoutError" || e?.name === "AbortError"
      ? "The site took longer than 10 seconds to respond."
      : "Couldn't reach that site. Check the address and try again.";
    throw new ScanError(msg, 502);
  }
  const timeMs = performance.now() - t0;
  const origin = new URL(page.url).origin;

  const side = { timeout: SIDE_TIMEOUT_MS };
  const [robots, llms] = await Promise.all([
    soft(get(origin + "/robots.txt", { ...side, accept: "text/plain,*/*" })),
    soft(get(origin + "/llms.txt", { ...side, accept: "text/plain,text/markdown,*/*" })),
  ]);

  const listed = robots && robots.status === 200
    ? (robots.text.match(/^\s*sitemap\s*:\s*(\S+)/gim) || []).map((l) => l.replace(/^\s*sitemap\s*:\s*/i, ""))
    : [];
  const candidates = [...new Set([...listed.slice(0, 2), origin + "/sitemap.xml", origin + "/sitemap_index.xml"])];
  // Fetch the candidates together (only the first 64 KB: enough to see the root tag); the first valid one in order wins.
  const tries = await Promise.all(candidates.map((c) =>
    soft(get(c, { ...side, maxBytes: 65_536, accept: "application/xml,text/xml,*/*" }))));
  const hit = tries.find((r) => r && r.status === 200 && /<(urlset|sitemapindex)\b/i.test(r.text));
  const sitemap = hit ? { status: 200, url: hit.url } : null;

  const isHtml = /html|xml/i.test(page.headers["content-type"] || "text/html");
  return analyze({
    url: page.url,
    status: isHtml ? page.status : 415,
    headers: page.headers,
    html: isHtml ? page.text : "",
    timeMs,
    robots: robots && { status: robots.status, text: robots.status === 200 ? robots.text : "" },
    llms: llms && { status: llms.status, text: llms.status === 200 ? llms.text : "" },
    sitemap,
  });
}
