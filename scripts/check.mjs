// Offline self-check for the analyzer: node scripts/check.mjs
import assert from "node:assert/strict";
import { analyze } from "../worker/src/analyze.js";

const scan = (html, extra = {}) =>
  analyze({ url: "https://ex.com/p", status: 200, headers: {}, html, timeMs: 100, robots: null, llms: null, sitemap: null, ...extra });
const get = (r, id) => r.checks.find((c) => c.id === id);

// A bot-protection challenge isn't the page: content checks are skipped and the score is capped.
const wall = scan("<html><head><title>Just a moment...</title></head><body></body></html>");
assert.equal(get(wall, "status").status, "fail");
assert.equal(wall.categories.find((c) => c.id === "meta").score, null);
assert.ok(wall.score <= 25);

const page = scan(`<html><head><meta name="robots" content="max-snippet:0"></head><body><main>
  <h2>How much does it cost?</h2><p>It costs 20 euros a month, billed yearly, and you can cancel at any time without a fee.</p>
  <h2>Why?</h2><p>Because.</p></main></body></html>`);
assert.equal(get(page, "snippet").status, "fail");
assert.equal(get(page, "questions").status, "warn"); // two questions, one answered directly
assert.equal(page.quotes.length, 1);
assert.match(get(page, "canonical").snippet, /href="https:\/\/ex\.com\/p"/);

// Blocked search crawlers get an allow-group; training crawlers stay out of it.
const blocked = scan("<html><body>x</body></html>", { robots: { status: 200, text: "User-agent: *\nDisallow: /" } });
assert.match(get(blocked, "robots").snippet, /^User-agent: OAI-SearchBot/);
assert.doesNotMatch(get(blocked, "robots").snippet, /GPTBot/);

console.log("ok");
