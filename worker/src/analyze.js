// AEO readiness analysis. Pure functions: takes already-fetched resources,
// returns a report. No I/O here, so it runs the same in the Worker and in Node.

export const AI_BOTS = [
  { ua: "GPTBot", owner: "OpenAI", role: "Training" },
  { ua: "OAI-SearchBot", owner: "OpenAI", role: "ChatGPT search" },
  { ua: "ChatGPT-User", owner: "OpenAI", role: "User fetches" },
  { ua: "ClaudeBot", owner: "Anthropic", role: "Training" },
  { ua: "Claude-SearchBot", owner: "Anthropic", role: "Claude search" },
  { ua: "Claude-User", owner: "Anthropic", role: "User fetches" },
  { ua: "PerplexityBot", owner: "Perplexity", role: "Search index" },
  { ua: "Google-Extended", owner: "Google", role: "Gemini / AI Overviews" },
  { ua: "Bingbot", owner: "Microsoft", role: "Bing → ChatGPT, Copilot" },
  { ua: "Applebot-Extended", owner: "Apple", role: "Apple Intelligence" },
  { ua: "CCBot", owner: "Common Crawl", role: "Open dataset" },
];

export const CATEGORIES = [
  { id: "access", title: "Crawler access", blurb: "Can answer engines reach and read the page?" },
  { id: "meta", title: "Metadata", blurb: "Does the page say clearly what it is?" },
  { id: "structure", title: "Content structure", blurb: "Is the content easy to lift into an answer?" },
  { id: "authority", title: "Schema & authority", blurb: "Can a model tell who stands behind it?" },
];

/* ---------------- HTML helpers (regex-based, deliberately forgiving) ---------------- */

const decode = (s) =>
  s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

const stripTags = (s) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const words = (s) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const inner = tag.replace(/^<\s*[a-zA-Z0-9-]+/, "").replace(/\/?>$/, "");
  let m;
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

const tagsOf = (html, name) => (html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) || []).map(attrs);

const elements = (html, name) => {
  const re = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}\\s*>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ attrs: attrs(`<x ${m[1]}>`), inner: m[2], text: stripTags(m[2]) });
  return out;
};

function metaContent(metas, key) {
  const k = key.toLowerCase();
  const hit = metas.find((m) => (m.name || m.property || m["http-equiv"] || "").toLowerCase() === k);
  return hit ? (hit.content || "").trim() : null;
}

/* ---------------- robots.txt ---------------- */

export function parseRobots(txt) {
  const groups = [];
  const sitemaps = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of (txt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([a-zA-Z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (key === "sitemap") sitemaps.push(val);
      else if (cur && (key === "allow" || key === "disallow")) cur.rules.push({ allow: key === "allow", path: val });
    }
  }
  return { groups, sitemaps };
}

function ruleMatches(rulePath, path) {
  if (!rulePath) return false;
  const anchored = rulePath.endsWith("$");
  const body = (anchored ? rulePath.slice(0, -1) : rulePath)
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + body + (anchored ? "$" : "")).test(path);
}

// Google-style: most specific user-agent group wins; within it, longest matching rule wins, allow wins ties.
export function robotsVerdict(robots, ua, path) {
  const name = ua.toLowerCase();
  let group = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && name.startsWith(a)));
  let matchedBy = ua;
  if (!group.length) {
    group = robots.groups.filter((g) => g.agents.includes("*"));
    matchedBy = "*";
  }
  if (!group.length) return { allowed: true, matchedBy: null, rule: null };
  const rules = group.flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return {
    allowed: !best || best.allow,
    matchedBy,
    rule: best ? `${best.allow ? "Allow" : "Disallow"}: ${best.path}` : null,
  };
}

/* ---------------- check builder ---------------- */

// Why each check matters for AI answers. One line, shown next to the finding.
const WHY = {
  status: "An answer engine can only quote what it can download. Errors and bot walls drop the page from its index.",
  https: "Crawlers and browsers treat plain HTTP as less trustworthy, and some skip it.",
  noindex: "noindex removes the page from the search indexes that ChatGPT, Perplexity and Gemini draw their sources from.",
  snippet: "nosnippet and max-snippet:0 forbid quoting the page. Google applies them to AI Overviews and AI Mode too.",
  robots: "Each AI product fetches with its own crawler. A blocked crawler means that product can't read or cite the page.",
  llms: "llms.txt is a short Markdown map of the site written for language models. It's cheap to add and some agents read it first.",
  sitemap: "A sitemap is how crawlers find new and updated pages quickly. ChatGPT search leans on Bing, which uses it heavily.",
  rawtext: "Most AI crawlers read the raw HTML and don't run JavaScript. Text that only appears after scripts run is invisible to them.",
  speed: "Crawlers give up on slow pages, and answer engines fetching live for a user have only a few seconds.",
  title: "The title is the strongest label for what the page is about, and it's what a citation link shows.",
  description: "Engines use the description as a ready-made summary of the page when deciding what to cite.",
  canonical: "The canonical tells engines which URL to index and cite. Without it, signals split across duplicates.",
  lang: "Engines answer in the user's language and match sources to it.",
  og: "Chat interfaces build their source cards and link previews from Open Graph tags.",
  freshness: "Answer engines prefer recent sources, and they can only tell what's recent from a machine-readable date.",
  h1: "The H1 is the page's main claim. Models use it to decide which question the page answers.",
  hierarchy: "Models split pages into chunks by heading. A clean outline keeps each answer with its topic.",
  questions: "AI answers are built from short passages that answer a question directly. A question heading with a 1–3 sentence answer under it is exactly that shape.",
  answerfirst: "The first paragraph is the most likely passage to be quoted as the summary of the page.",
  lists: "Steps, comparisons and specs in real lists and tables are easy to lift into an answer intact.",
  semantic: "Landmarks let crawlers separate the content from menus, cookie banners and footers.",
  alt: "Text-only models know what an image shows only from its alt text.",
  jsonld: "Structured data states facts (what, who, when, price) in a form machines read without guessing.",
  entity: "Models connect a page to an organisation or person through schema and sameAs links. That's how they know who is talking.",
  pagetype: "The schema type says what kind of page it is: an article, a product, a service.",
  author: "A named, verifiable author is a trust signal engines use when picking which source to quote.",
  faq: "FAQPage markup labels the question-and-answer pairs explicitly.",
  links: "Internal links show engines the rest of your coverage; cited sources back up the claims they'd quote.",
  facts: "Models prefer passages with specific, checkable facts. Numbers are what they can't get from everyone else.",
};

function check(category, id, title, weight, status, detail, fix, snippet) {
  return { category, id, title, weight, status, detail, why: WHY[id], fix: status === "pass" ? null : fix, snippet: status === "pass" ? null : snippet || null };
}

const QUESTION_START =
  /^(how|what|why|when|where|who|which|can|do|does|is|are|should|will|hur|vad|varför|när|var|vem|vilken|vilka|kan|är|ska|måste)\b/i;

/* ---------------- main ---------------- */

/**
 * @param {object} input
 * @param {string} input.url            final URL after redirects
 * @param {number} input.status         HTTP status of the page
 * @param {object} input.headers        lower-cased response headers
 * @param {string} input.html
 * @param {number} input.timeMs         time to fetch the page
 * @param {{status:number, text:string}|null} input.robots
 * @param {{status:number, text:string}|null} input.llms
 * @param {{status:number, url:string}|null} input.sitemap
 */
export function analyze(input) {
  const { url, status, headers = {}, html = "", timeMs, robots, llms, sitemap } = input;
  const u = new URL(url);
  const checks = [];
  const add = (...a) => checks.push(check(...a));

  const head = (html.match(/<head\b[\s\S]*?<\/head>/i) || [html])[0];
  const metas = tagsOf(head, "meta");
  const links = tagsOf(head, "link");
  const body = (html.match(/<body\b[\s\S]*<\/body>/i) || [html])[0];
  const cleanBody = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const mainMatch = cleanBody.match(/<main\b[\s\S]*?<\/main>/i) || cleanBody.match(/<article\b[\s\S]*?<\/article>/i);
  const contentHtml = mainMatch ? mainMatch[0] : cleanBody;
  const bodyText = stripTags(cleanBody);
  const wordCount = words(bodyText);

  /* ---------- JSON-LD ---------- */
  const ldBlocks = elements(html, "script").filter((s) => /ld\+json/i.test(s.attrs.type || ""));
  let ldErrors = 0;
  const ldNodes = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (n["@type"]) ldNodes.push(n);
    for (const k of Object.keys(n)) if (k !== "@context" && typeof n[k] === "object") walk(n[k]);
  };
  for (const b of ldBlocks) {
    try {
      walk(JSON.parse(b.inner.trim()));
    } catch {
      ldErrors++;
    }
  }
  const types = new Set(ldNodes.flatMap((n) => [].concat(n["@type"]).map(String)));
  const hasType = (...t) => t.some((x) => types.has(x));

  /* ================= ACCESS ================= */

  // A bot wall can answer 200 with a challenge page; scoring its "content" would be noise.
  const challenge = headers["cf-mitigated"] === "challenge" ||
    /<title>\s*(just a moment|attention required|access denied|verify you are human)/i.test(html) ||
    /captcha-delivery\.com|enable js and disable any ad blocker|cf-chl-|_incapsula_/i.test(html);
  const readable = status >= 200 && status < 300 && !challenge && status !== 415;
  add("access", "status", "Page responds with 200", 3,
    readable ? "pass" : "fail",
    readable
      ? `HTTP ${status}${u.protocol === "https:" ? " over HTTPS" : ""}.`
      : status === 415
        ? "The URL doesn't return an HTML page."
        : challenge
          ? `HTTP ${status}, but the response is a bot-protection challenge, not the page. Crawlers get the same wall.`
          : `HTTP ${status}. Crawlers treat this page as unavailable.${status === 403 || status === 429 ? " A firewall or bot protection may be blocking automated visitors." : ""}`,
    challenge || status === 403 || status === 429 || status === 503
      ? "In your bot protection (Cloudflare Bot Fight Mode, WAF or CDN rules), allow verified AI crawlers: OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot and Bingbot. On Cloudflare: Security → Bots → allow \"Verified bots\"."
      : status === 415 ? "Scan an HTML page URL." : "Make sure the URL returns 200 without requiring cookies, login or a JavaScript challenge.");

  if (u.protocol !== "https:")
    add("access", "https", "Served over HTTPS", 1, "fail", "The page loads over plain HTTP.", "Redirect all traffic to HTTPS.");

  const robotsTag = [headers["x-robots-tag"] || "", metaContent(metas, "robots") || "", metaContent(metas, "googlebot") || ""].join(",").toLowerCase();
  const found = `Found "${robotsTag.replace(/^,+|,+$/g, "").replace(/,,+/g, ",")}".`;
  const noindex = /noindex|\bnone\b/.test(robotsTag);
  if (readable || headers["x-robots-tag"]) {
    add("access", "noindex", "Page is indexable", 3, noindex ? "fail" : "pass",
      noindex ? `${found} Search and answer engines are told to leave this page out.` : "No noindex directive in meta robots or X-Robots-Tag.",
      "Remove noindex from the meta robots tag and the X-Robots-Tag header, unless you really want this page hidden.");
    const nosnippet = /nosnippet|max-snippet\s*:\s*0\b/.test(robotsTag);
    add("access", "snippet", "Page may be quoted", 2, nosnippet ? "fail" : "pass",
      nosnippet ? `${found} Engines may index the page but not quote from it.` : "No nosnippet or max-snippet limit.",
      "Remove nosnippet / max-snippet:0. To hide just one block from quotes, put data-nosnippet on that element instead.");
  }

  const bots = AI_BOTS.map((b) => {
    if (!robots || robots.status >= 400) return { ...b, allowed: true, matchedBy: null, rule: null };
    return { ...b, ...robotsVerdict(parseRobots(robots.text), b.ua, u.pathname + u.search) };
  });
  const blocked = bots.filter((b) => !b.allowed);
  const blockedSearch = blocked.filter((b) => /search|fetches|Bing|Overviews|Perplexity/i.test(b.role + b.owner));
  const robotsSnippet = blocked.length
    ? blocked.map((b) => `User-agent: ${b.ua}`).join("\n") + "\nAllow: /\n"
    : null;
  add("access", "robots", "robots.txt lets AI crawlers in", 4,
    !blocked.length ? "pass" : blockedSearch.length ? "fail" : "warn",
    !robots || robots.status >= 400
      ? "No robots.txt found. Crawlers are allowed by default."
      : !blocked.length
        ? `All ${bots.length} AI crawlers checked may fetch this page.`
        : `Blocked: ${blocked.map((b) => b.ua).join(", ")}.`,
    blockedSearch.length
      ? `${blockedSearch.map((b) => b.ua).join(", ")} fetch pages for live AI answers, so blocking them removes you from those answers. Add this group to robots.txt (a named group overrides User-agent: *). Blocking training-only crawlers like GPTBot is a separate choice.`
      : "Only training crawlers are blocked. That's a valid choice, but make it deliberately: it can reduce how well models know your brand. To let them in, add this group to robots.txt (a named group overrides User-agent: *):",
    blockedSearch.length ? robotsSnippet.replace(/^User-agent: (GPTBot|ClaudeBot|CCBot|Google-Extended|Applebot-Extended)\n/gm, "") : robotsSnippet);

  const title = (elements(head, "title")[0]?.text || "").trim();
  const desc = metaContent(metas, "description");
  const siteName = metaContent(metas, "og:site_name") || title.split(/\s[|–—-]\s/).pop() || u.hostname;
  const llmsText = llms && llms.status === 200 && !/<html/i.test(llms.text) ? llms.text.trim() : "";
  const llmsH1 = /^#\s+\S/m.test(llmsText);
  const llmsLinks = (llmsText.match(/\]\([^)]+\)/g) || []).length;
  add("access", "llms", "llms.txt in the site root", 2,
    llmsText.length > 20 ? (llmsH1 && llmsLinks ? "pass" : "warn") : "fail",
    llmsText.length > 20
      ? `Found /llms.txt (${words(llmsText)} words, ${llmsLinks} link${llmsLinks === 1 ? "" : "s"}${llmsH1 ? "" : ", no # title"}).`
      : "No /llms.txt found.",
    llmsText.length > 20
      ? "Follow the llms.txt format: start with a # title line, a > one-line summary, then ## sections with Markdown links to your key pages."
      : "Add /llms.txt in the site root: a # title, a > one-line summary, then ## sections listing your key pages as Markdown links. Start from this:",
    `# ${siteName}\n\n> ${desc || "One sentence on who you are and what you offer."}\n\n## Key pages\n\n- [${title || "Home"}](${u.origin}${u.pathname}): one line on what this page covers\n- [About](${u.origin}/about): who we are\n`);

  add("access", "sitemap", "XML sitemap available", 2,
    sitemap && sitemap.status === 200 ? "pass" : "fail",
    sitemap && sitemap.status === 200 ? `Found ${sitemap.url.replace(u.origin, "")}.` : "No sitemap at /sitemap.xml or in robots.txt.",
    "Publish a sitemap with honest lastmod dates, list it in robots.txt, and submit it to both Google Search Console and Bing Webmaster Tools. ChatGPT search relies on Bing's index.");

  if (!readable) return finish();

  const scripts = (html.match(/<script\b/gi) || []).length;
  const shell = wordCount < 80 && (/<div\b[^>]*\bid=["'](root|app|__next|__nuxt|svelte|q-app)["'][^>]*>\s*<\/div>/i.test(html) || scripts >= 5);
  add("access", "rawtext", "Content readable without JavaScript", 4,
    wordCount >= 250 ? "pass" : wordCount >= 80 ? "warn" : "fail",
    `${wordCount} words of text in the raw HTML.${shell ? ` The page looks like a JavaScript app shell (${scripts} scripts): its content only appears after scripts run, so most AI crawlers see an empty page.` : ""}`,
    wordCount < 80
      ? "Most AI crawlers don't run JavaScript. Server-render or pre-render the main content so it's in the HTML response."
      : "The page is thin in raw HTML. Answer engines prefer pages with enough substance to quote. Aim for 300+ words of real content, or confirm key content isn't loaded client-side.");

  add("access", "speed", "Fast server response", 1,
    timeMs <= 1200 ? "pass" : timeMs <= 3000 ? "warn" : "fail",
    `HTML fetched in ${Math.round(timeMs)} ms.`,
    "Crawlers have tight time budgets. Cache HTML at the edge and cut server response time below ~1 s.");

  /* ================= METADATA ================= */

  add("meta", "title", "Descriptive title", 3,
    title.length >= 15 && title.length <= 65 ? "pass" : title ? "warn" : "fail",
    title ? `"${title}" (${title.length} chars).` : "No <title> tag.",
    !title ? "Add a unique <title> that names the page topic first." : title.length < 15 ? "Title is very short. Say what the page is about, topic first, brand last." : "Title is long and may be cut off. Keep it under ~60 characters with the topic first.");

  add("meta", "description", "Meta description", 2,
    desc && desc.length >= 70 && desc.length <= 170 ? "pass" : desc ? "warn" : "fail",
    desc ? `${desc.length} chars: "${desc.slice(0, 160)}${desc.length > 160 ? "…" : ""}"` : "No meta description.",
    "Write a 120–160 character description that answers \"what is this page?\" in plain words. Engines often reuse it as a summary.");

  const canonical = links.find((l) => (l.rel || "").toLowerCase().split(/\s+/).includes("canonical"))?.href;
  const bare = (x) => x.host.replace(/^www\./, "") + x.pathname.replace(/\/$/, "");
  let canonSame = false;
  try {
    canonSame = !!canonical && bare(new URL(canonical, url)) === bare(u);
  } catch {}
  add("meta", "canonical", "Canonical URL", 2,
    canonSame ? "pass" : canonical ? "warn" : "fail",
    canonical
      ? canonSame ? `Canonical → ${canonical}` : `Canonical points to a different URL: ${canonical}. Engines will index and cite that page instead of this one.`
      : "No canonical link.",
    canonical
      ? "If this page should be cited in its own right, point the canonical at its own URL. If it's a duplicate, that's fine: scan the canonical URL instead."
      : "Add a canonical link to the <head> so duplicates (tracking parameters, www/non-www) don't split signals:",
    `<link rel="canonical" href="${u.origin}${u.pathname}">`);

  const lang = (html.match(/<html\b[^>]*>/i) || [""])[0];
  const langVal = attrs(lang).lang;
  add("meta", "lang", "Language declared", 1, langVal ? "pass" : "fail",
    langVal ? `lang="${langVal}"` : "No lang attribute on <html>.",
    "Set <html lang=\"…\"> so engines match the page to queries in the right language.");

  const og = ["og:title", "og:description", "og:image"].filter((k) => metaContent(metas, k));
  add("meta", "og", "Open Graph tags", 1, og.length === 3 ? "pass" : og.length ? "warn" : "fail",
    og.length ? `Has ${og.join(", ")}.` : "No Open Graph tags.",
    "Add og:title, og:description and og:image. Chat interfaces use them for link previews and source cards.");

  const dateSignals = [];
  if (ldNodes.some((n) => n.dateModified)) dateSignals.push("schema dateModified");
  else if (ldNodes.some((n) => n.datePublished)) dateSignals.push("schema datePublished");
  if (metaContent(metas, "article:modified_time") || metaContent(metas, "article:published_time")) dateSignals.push("article meta");
  if (/<time\b[^>]*datetime=/i.test(cleanBody)) dateSignals.push("<time> element");
  add("meta", "freshness", "Publish / update date", 2, dateSignals.length ? "pass" : "warn",
    dateSignals.length ? `Date found via ${dateSignals.join(", ")}.` : "No machine-readable date found.",
    "Show a visible updated date and mirror it in schema (dateModified). Keep it honest: only bump it when the content really changes. Fresh pages get cited more often.");

  /* ================= STRUCTURE ================= */

  const heads = [];
  const hre = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let hm;
  while ((hm = hre.exec(cleanBody))) heads.push({ level: +hm[1], text: stripTags(hm[2]) });
  const h1s = heads.filter((h) => h.level === 1);
  add("structure", "h1", "Exactly one H1", 3, h1s.length === 1 ? "pass" : h1s.length ? "warn" : "fail",
    h1s.length === 1 ? `"${h1s[0].text.slice(0, 90)}"` : h1s.length ? `${h1s.length} H1s found.` : "No H1 found.",
    h1s.length ? "Use a single H1 that states the page's main topic; demote the rest to H2." : "Add one H1 that states what the page is about.");

  let skips = [];
  for (let i = 1; i < heads.length; i++)
    if (heads[i].level > heads[i - 1].level + 1) skips.push(`H${heads[i - 1].level}→H${heads[i].level}`);
  skips = [...new Set(skips)];
  const subheads = heads.filter((h) => h.level === 2 || h.level === 3);
  add("structure", "hierarchy", "Logical heading outline", 2,
    heads.length && !skips.length && subheads.length >= 2 ? "pass" : "warn",
    !heads.length ? "No headings found." : skips.length ? `Skipped levels: ${skips.join(", ")}.` : `${subheads.length} H2/H3 headings.`,
    skips.length ? "Don't skip heading levels. Models use the outline to understand which text answers which topic." : "Break content into sections with descriptive H2/H3 headings.");

  // Answer-shaped passages: a question heading followed straight away by a short, standalone answer.
  const isQ = (t) => /\?\s*$/.test(t) || QUESTION_START.test(t);
  const sections = [];
  const sre = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let sm;
  while ((sm = sre.exec(cleanBody))) sections.push({ level: +sm[1], text: stripTags(sm[2]), from: sre.lastIndex, to: cleanBody.length });
  sections.forEach((x, i) => sections[i + 1] && (x.to = cleanBody.indexOf("<h" + sections[i + 1].level, x.from)));
  const questions = sections.filter((x) => x.level >= 2 && x.level <= 4 && isQ(x.text)).map((x) => {
    const chunk = cleanBody.slice(x.from, Math.max(x.from, x.to));
    // ponytail: first <p> or, for accordion FAQs without <p>, the section's text; misses answers split across several tags
    const answer = (elements(chunk, "p").map((p) => p.text).find((t) => words(t) >= 5) || stripTags(chunk)).slice(0, 600);
    const w = words(answer);
    return { q: x.text, a: answer, direct: w >= 12 && w <= 90 };
  });
  const answered = questions.filter((x) => x.direct);
  add("structure", "questions", "Questions answered right below", 3,
    answered.length >= 2 ? "pass" : questions.length ? "warn" : "fail",
    questions.length
      ? `${questions.length} question heading${questions.length === 1 ? "" : "s"}, ${answered.length} with a short direct answer underneath: ${questions.slice(0, 3).map((q) => `"${q.q.slice(0, 60)}"`).join(", ")}${questions.length > 3 ? "…" : ""}`
      : "No headings phrased as questions.",
    questions.length && questions.length > answered.length
      ? "Right under each question heading, start with a 1–3 sentence answer (about 20–60 words) that makes sense on its own, then add the detail. A long or missing first paragraph can't be lifted as an answer."
      : "Phrase two or more H2s the way people ask (\"How much does X cost?\") and answer each in 20–60 words directly underneath. These answer blocks are what engines lift.");

  const paras = elements(contentHtml, "p").map((p) => p.text).filter((t) => words(t) >= 8);
  const firstPara = paras[0] || "";
  const fw = words(firstPara);
  add("structure", "answerfirst", "Gets to the point early", 3,
    fw >= 15 && fw <= 90 ? "pass" : fw ? "warn" : "fail",
    fw ? `First paragraph: ${fw} words. "${firstPara.slice(0, 140)}${firstPara.length > 140 ? "…" : ""}"` : "No real paragraphs (<p>) found in the main content.",
    fw > 90
      ? "The opening paragraph is long. Lead with a short, standalone answer (one or two sentences), then give the background."
      : "Open with a short paragraph that answers the page's core question directly, as real <p> text.");

  const lists = (contentHtml.match(/<(ul|ol)\b/gi) || []).length;
  const tables = (contentHtml.match(/<table\b/gi) || []).length;
  add("structure", "lists", "Lists or tables", 2, lists + tables ? "pass" : "warn",
    lists + tables ? `${lists} list${lists === 1 ? "" : "s"}, ${tables} table${tables === 1 ? "" : "s"} in the content.` : "No lists or tables in the main content.",
    "Use real <ul>/<ol> and <table> markup for steps, comparisons and specs. Structured fragments are easy to quote.");

  const landmarks = ["main", "article", "nav", "header", "footer"].filter((t) => new RegExp(`<${t}\\b`, "i").test(cleanBody));
  add("structure", "semantic", "Semantic landmarks", 1,
    landmarks.includes("main") || landmarks.includes("article") ? "pass" : "warn",
    landmarks.length ? `Uses <${landmarks.join(">, <")}>.` : "Only generic <div>s.",
    "Wrap the primary content in <main> (or <article>) so crawlers can separate it from menus and footers.");

  const imgs = tagsOf(cleanBody, "img");
  const withAlt = imgs.filter((i) => (i.alt || "").trim()).length;
  if (imgs.length)
    add("structure", "alt", "Images have alt text", 1,
      withAlt / imgs.length >= 0.8 ? "pass" : withAlt / imgs.length >= 0.4 ? "warn" : "fail",
      `${withAlt} of ${imgs.length} images have alt text.`,
      "Describe informative images in alt text. It's the only way text-based models know what they show.");

  /* ================= SCHEMA & AUTHORITY ================= */

  add("authority", "jsonld", "Structured data (JSON-LD)", 3,
    ldNodes.length && !ldErrors ? "pass" : ldNodes.length ? "warn" : "fail",
    ldNodes.length
      ? `Types: ${[...types].slice(0, 8).join(", ")}${ldErrors ? `. ${ldErrors} block(s) failed to parse.` : ""}`
      : ldErrors ? `${ldErrors} JSON-LD block(s), none valid.` : "No JSON-LD found.",
    ldErrors ? "Fix the invalid JSON-LD. Engines skip blocks that don't parse." : "Add JSON-LD server-side: Organization site-wide, plus Article, Service, Product or similar per page.");

  const org = ldNodes.find((n) => [].concat(n["@type"]).some((t) => /Organization|LocalBusiness|Corporation|Person/.test(t)));
  const sameAs = org ? [].concat(org.sameAs || []) : [];
  add("authority", "entity", "Organization identity with sameAs", 3,
    org && sameAs.length ? "pass" : org ? "warn" : "fail",
    org ? `${[].concat(org["@type"])[0]} "${org.name || "?"}"${sameAs.length ? ` with ${sameAs.length} sameAs link${sameAs.length === 1 ? "" : "s"}` : ", no sameAs"}.` : "No Organization or Person schema.",
    org ? "Add sameAs links to your official profiles (LinkedIn, Wikipedia, Crunchbase, company registry) so models can confirm the entity." : "Add Organization (or Person, for a personal site) schema in the <head> of every page, with your exact name, logo and official profiles:",
    org ? null : `<script type="application/ld+json">\n${JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name: siteName, url: u.origin + "/", logo: u.origin + "/logo.png", sameAs: ["https://www.linkedin.com/company/…", "https://en.wikipedia.org/wiki/…"] }, null, 2)}\n</script>`);

  const pageType = [...types].find((t) =>
    /^(Article|BlogPosting|NewsArticle|TechArticle|Service|Product|SoftwareApplication|FAQPage|HowTo|Recipe|Course|Event|WebPage|AboutPage|CollectionPage|ProfessionalService)$/.test(t));
  add("authority", "pagetype", "Page-level schema type", 2, pageType ? "pass" : "warn",
    pageType ? `Page is typed as ${pageType}.` : "Nothing says what kind of page this is.",
    "Describe the page itself: Article/BlogPosting for posts, Service or Product for offerings, with headline, description and dates.");

  const authorMeta = metaContent(metas, "author");
  const authorLd = ldNodes.find((n) => n.author)?.author || ldNodes.find((n) => n.publisher)?.publisher;
  const authorName = authorLd ? [].concat(authorLd)[0]?.name || (typeof authorLd === "string" ? authorLd : null) : authorMeta;
  add("authority", "author", "Named author or publisher", 2, authorName || hasType("Person") ? "pass" : "warn",
    authorName ? `Author: ${authorName}.` : hasType("Person") ? "Person schema present." : "No named author.",
    "Name a real author with a Person schema (role, sameAs). Content with a verifiable author carries more weight than anonymous text.");

  if (answered.length >= 2 || hasType("FAQPage"))
    add("authority", "faq", "FAQ markup matches visible Q&A", 2, hasType("FAQPage") ? "pass" : "warn",
      hasType("FAQPage") ? "FAQPage schema present." : `${answered.length} answered questions but no FAQPage schema.`,
      "Mark the visible questions and answers up as FAQPage, word for word. Only mark up questions that are on the page. Built from this page:",
      `<script type="application/ld+json">\n${JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: answered.slice(0, 6).map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })) }, null, 2)}\n</script>`);

  const anchors = tagsOf(contentHtml, "a").map((a) => a.href).filter(Boolean);
  let external = 0, internal = 0;
  for (const h of anchors) {
    try {
      const t = new URL(h, url);
      if (!/^https?:$/.test(t.protocol)) continue;
      t.host.replace(/^www\./, "") === u.host.replace(/^www\./, "") ? internal++ : external++;
    } catch {}
  }
  add("authority", "links", "Internal links & cited sources", 2,
    internal >= 3 && external >= 1 ? "pass" : internal || external ? "warn" : "fail",
    `${internal} internal, ${external} external link${external === 1 ? "" : "s"} in the content.`,
    "Link related pages together with descriptive anchor text to build topic clusters, and link out to sources behind your claims.");

  const stats = (stripTags(contentHtml).match(/\b\d[\d\s.,]*\s?(%|percent|procent|kr\b|sek|usd|eur|\$|€|x\b|times|ggr|million|miljoner|billion|k\b|kcal|kj\b|mg\b|g\b|kg\b|ml\b|cl\b|l\b|cm\b|mm\b|km\b|m²|ms\b|sec|seconds|sekunder|min\b|minutes|minuter|hours|timmar|days|dagar|weeks|veckor|months|månader|years|år\b|users|customers|kunder|st\b|pcs)|[$€£]\s?\d/gi) || []).length;
  add("authority", "facts", "Concrete facts and figures", 2, stats >= 3 ? "pass" : stats ? "warn" : "fail",
    `${stats} figure${stats === 1 ? "" : "s"} (percentages, prices, amounts) in the content.`,
    "Add specific numbers, prices, dates and named examples, each with its source in the same sentence. Original data is what models can't get anywhere else.");

  return finish();

  function finish() {

  const pts = { pass: 1, warn: 0.5, fail: 0 };
  const scoreOf = (list) => {
    const total = list.reduce((s, c) => s + c.weight, 0);
    return total ? Math.round((100 * list.reduce((s, c) => s + c.weight * pts[c.status], 0)) / total) : 0;
  };
  const categories = CATEGORIES.map((c) => {
    const list = checks.filter((k) => k.category === c.id);
    return { ...c, score: list.length ? scoreOf(list) : null, passed: list.filter((k) => k.status === "pass").length, total: list.length };
  });
  // A page crawlers can't get at is not "partly ready": cap the score.
  let score = scoreOf(checks);
  const hardFail = !readable || checks.some((c) => c.id === "noindex" && c.status === "fail");
  if (hardFail) score = Math.min(score, 25);

  return {
    url,
    scannedAt: new Date().toISOString(),
    score,
    grade: score >= 85 ? "Ready" : score >= 65 ? "Almost there" : score >= 40 ? "Needs work" : "Hard to find",
    page: { title, description: desc, wordCount: readable ? wordCount : 0, timeMs: Math.round(timeMs), status, readable },
    categories,
    checks,
    bots,
    // The passages an engine is most likely to lift: answered questions, else the opening paragraph.
    quotes: !readable ? [] : answered.length
      ? answered.slice(0, 3).map((x) => ({ q: x.q, a: x.a }))
      : firstPara ? [{ q: null, a: firstPara.slice(0, 600) }] : [],
  };
  }
}
