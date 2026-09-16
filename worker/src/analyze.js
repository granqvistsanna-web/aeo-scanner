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

function check(category, id, title, weight, status, detail, fix) {
  return { category, id, title, weight, status, detail, fix: status === "pass" ? null : fix };
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

  add("access", "status", "Page responds with 200", 3,
    status >= 200 && status < 300 ? "pass" : "fail",
    status >= 200 && status < 300
      ? `HTTP ${status}${u.protocol === "https:" ? " over HTTPS" : ""}.`
      : `HTTP ${status}. Crawlers treat this page as unavailable.${status === 403 || status === 429 ? " A firewall or bot protection may be blocking automated visitors." : ""}`,
    status === 403 || status === 503
      ? "Check your bot protection (Cloudflare Bot Fight Mode, WAF rules). It can block AI crawlers as well as this scanner."
      : "Make sure the URL returns 200 without requiring cookies, login or JavaScript challenges.");

  if (u.protocol !== "https:")
    add("access", "https", "Served over HTTPS", 1, "fail", "The page loads over plain HTTP.", "Redirect all traffic to HTTPS.");

  const robotsTag = [headers["x-robots-tag"] || "", metaContent(metas, "robots") || ""].join(",").toLowerCase();
  const noindex = /noindex|\bnone\b/.test(robotsTag);
  add("access", "noindex", "Page is indexable", 3, noindex ? "fail" : "pass",
    noindex ? `Found "${robotsTag.replace(/^,|,$/g, "")}". Search and answer engines are told to leave this page out.` : "No noindex directive in meta robots or X-Robots-Tag.",
    "Remove noindex from the meta robots tag / X-Robots-Tag header, unless you really want this page hidden.");

  const bots = AI_BOTS.map((b) => {
    if (!robots || robots.status >= 400) return { ...b, allowed: true, matchedBy: null, rule: null };
    return { ...b, ...robotsVerdict(parseRobots(robots.text), b.ua, u.pathname + u.search) };
  });
  const blocked = bots.filter((b) => !b.allowed);
  const blockedSearch = blocked.filter((b) => /search|fetches|Bing|Overviews|Perplexity/i.test(b.role + b.owner));
  add("access", "robots", "robots.txt lets AI crawlers in", 4,
    !blocked.length ? "pass" : blockedSearch.length ? "fail" : "warn",
    !robots || robots.status >= 400
      ? "No robots.txt found. Crawlers are allowed by default."
      : !blocked.length
        ? `All ${bots.length} AI crawlers checked may fetch this page.`
        : `Blocked: ${blocked.map((b) => b.ua).join(", ")}.`,
    blockedSearch.length
      ? "Blocking search/fetch bots (OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot, Bingbot) removes you from AI answers. Allow them in robots.txt. Blocking training-only bots is a separate, deliberate choice."
      : "Only training crawlers are blocked. That's a valid choice, but make it deliberately: it can reduce how well models know your brand.");

  add("access", "llms", "llms.txt in the site root", 2,
    llms && llms.status === 200 && llms.text.trim().length > 20 && !/<html/i.test(llms.text) ? "pass" : "fail",
    llms && llms.status === 200 && !/<html/i.test(llms.text)
      ? `Found /llms.txt (${words(llms.text)} words).`
      : "No /llms.txt found.",
    "Add /llms.txt: a Markdown file with a one-line summary of who you are, then linked lists of your key pages per section. It gives language models a clean map of the site.");

  add("access", "sitemap", "XML sitemap available", 2,
    sitemap && sitemap.status === 200 ? "pass" : "fail",
    sitemap && sitemap.status === 200 ? `Found ${sitemap.url.replace(u.origin, "")}.` : "No sitemap at /sitemap.xml or in robots.txt.",
    "Publish a sitemap with honest lastmod dates, list it in robots.txt, and submit it to both Google Search Console and Bing Webmaster Tools. ChatGPT search relies on Bing's index.");

  add("access", "rawtext", "Content readable without JavaScript", 4,
    wordCount >= 250 ? "pass" : wordCount >= 80 ? "warn" : "fail",
    `${wordCount} words of text in the raw HTML.`,
    wordCount < 80
      ? "Most AI crawlers don't run JavaScript. Server-render or pre-render the main content so it's in the HTML response."
      : "The page is thin in raw HTML. Answer engines prefer pages with enough substance to quote. Aim for 300+ words of real content, or confirm key content isn't loaded client-side.");

  add("access", "speed", "Fast server response", 1,
    timeMs <= 1200 ? "pass" : timeMs <= 3000 ? "warn" : "fail",
    `HTML fetched in ${Math.round(timeMs)} ms.`,
    "Crawlers have tight time budgets. Cache HTML at the edge and cut server response time below ~1 s.");

  /* ================= METADATA ================= */

  const title = (elements(head, "title")[0]?.text || "").trim();
  add("meta", "title", "Descriptive title", 3,
    title.length >= 15 && title.length <= 65 ? "pass" : title ? "warn" : "fail",
    title ? `"${title}" (${title.length} chars).` : "No <title> tag.",
    !title ? "Add a unique <title> that names the page topic first." : title.length < 15 ? "Title is very short. Say what the page is about, topic first, brand last." : "Title is long and may be cut off. Keep it under ~60 characters with the topic first.");

  const desc = metaContent(metas, "description");
  add("meta", "description", "Meta description", 2,
    desc && desc.length >= 70 && desc.length <= 170 ? "pass" : desc ? "warn" : "fail",
    desc ? `${desc.length} chars: "${desc.slice(0, 160)}${desc.length > 160 ? "…" : ""}"` : "No meta description.",
    "Write a 120–160 character description that answers \"what is this page?\" in plain words. Engines often reuse it as a summary.");

  const canonical = links.find((l) => (l.rel || "").toLowerCase().split(/\s+/).includes("canonical"))?.href;
  let canonOk = false;
  try {
    canonOk = !!canonical && new URL(canonical, url).host === u.host;
  } catch {}
  add("meta", "canonical", "Canonical URL", 2,
    canonOk ? "pass" : canonical ? "warn" : "fail",
    canonical ? `Canonical → ${canonical}` : "No canonical link.",
    canonical ? "The canonical points to another host. Make sure that's intended." : "Add <link rel=\"canonical\"> so duplicates don't split signals.");

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

  const questions = subheads.filter((h) => /\?\s*$/.test(h.text) || QUESTION_START.test(h.text));
  add("structure", "questions", "Question-style headings", 3,
    questions.length >= 2 ? "pass" : questions.length === 1 ? "warn" : "fail",
    questions.length ? `${questions.length}: ${questions.slice(0, 3).map((q) => `"${q.text.slice(0, 60)}"`).join(", ")}${questions.length > 3 ? "…" : ""}` : "No headings phrased as questions.",
    "Phrase some H2/H3s the way people ask (\"How much does X cost?\") and answer each in the first 40–60 words below it. These answer blocks are what engines lift.");

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
    org ? "Add sameAs links to your official profiles (LinkedIn, Wikipedia, Crunchbase, company registry) so models can confirm the entity." : "Add Organization schema with your exact brand name, logo, URL and sameAs links to official profiles.");

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

  if (questions.length >= 2 || hasType("FAQPage"))
    add("authority", "faq", "FAQ markup matches visible Q&A", 2, hasType("FAQPage") ? "pass" : "warn",
      hasType("FAQPage") ? "FAQPage schema present." : `${questions.length} question headings but no FAQPage schema.`,
      "Mark visible question-and-answer sections up as FAQPage. Only mark up questions that are on the page; hidden FAQ markup gets penalised.");

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

  /* ================= scoring ================= */

  const pts = { pass: 1, warn: 0.5, fail: 0 };
  const scoreOf = (list) => {
    const total = list.reduce((s, c) => s + c.weight, 0);
    return total ? Math.round((100 * list.reduce((s, c) => s + c.weight * pts[c.status], 0)) / total) : 0;
  };
  const categories = CATEGORIES.map((c) => {
    const list = checks.filter((k) => k.category === c.id);
    return { ...c, score: scoreOf(list), passed: list.filter((k) => k.status === "pass").length, total: list.length };
  });
  // A page crawlers can't get at is not "partly ready": cap the score.
  let score = scoreOf(checks);
  const hardFail = checks.some((c) => ["status", "noindex"].includes(c.id) && c.status === "fail");
  if (hardFail) score = Math.min(score, 25);

  return {
    url,
    scannedAt: new Date().toISOString(),
    score,
    grade: score >= 85 ? "Ready" : score >= 65 ? "Almost there" : score >= 40 ? "Needs work" : "Hard to find",
    page: { title, description: desc, wordCount, timeMs: Math.round(timeMs), status },
    categories,
    checks,
    bots,
  };
}
