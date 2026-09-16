import { scan, ScanError } from "./scan.js";

const ALLOWED_ORIGINS = [
  "https://granqvistsanna-web.github.io",
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

function cors(req) {
  const origin = req.headers.get("origin") || "";
  const ok = ALLOWED_ORIGINS.some((o) => (typeof o === "string" ? o === origin : o.test(origin)));
  return {
    "access-control-allow-origin": ok ? origin : ALLOWED_ORIGINS[0],
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

const json = (req, body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(req), ...extra },
  });

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    const { pathname, searchParams } = new URL(req.url);
    if (pathname !== "/scan") return json(req, { ok: true, usage: "GET /scan?url=example.com" });
    if (req.method !== "GET") return json(req, { error: "Method not allowed" }, 405);

    // Cache identical scans for 10 minutes to keep repeat hits off target sites.
    const cache = caches.default;
    const key = new Request(req.url, { method: "GET" });
    const hit = await cache.match(key);
    if (hit) {
      const res = new Response(hit.body, hit);
      Object.entries(cors(req)).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    try {
      const report = await scan(searchParams.get("url"));
      const res = json(req, report, 200, { "cache-control": "public, max-age=600" });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch (e) {
      if (e instanceof ScanError) return json(req, { error: e.message }, e.status);
      return json(req, { error: "Something went wrong while scanning." }, 500);
    }
  },
};
