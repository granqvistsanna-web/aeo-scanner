// Run a scan from Node without the Worker: node scripts/scan.mjs example.com [--json]
import { scan } from "../worker/src/scan.js";

const [url, flag] = process.argv.slice(2);
const r = await scan(url).catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
if (flag === "--json") {
  console.log(JSON.stringify(r, null, 2));
} else {
  const mark = { pass: "✓", warn: "~", fail: "✗" };
  console.log(`\n${r.url}\nScore ${r.score} — ${r.grade}\n`);
  for (const c of r.categories) {
    console.log(`${c.title}  ${c.score}  (${c.passed}/${c.total})`);
    for (const k of r.checks.filter((x) => x.category === c.id)) console.log(`  ${mark[k.status]} ${k.title}: ${k.detail}`);
  }
  console.log("\nBlocked bots:", r.bots.filter((b) => !b.allowed).map((b) => b.ua).join(", ") || "none");
}
