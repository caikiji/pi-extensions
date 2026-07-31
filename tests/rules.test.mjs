// Regression test for extensions/rules.ts (39 assertions).
// Loads the real extension with a fake pi API — no network, no pi session, no npm deps.
// Works on any machine: paths are resolved relative to this file.
// Requires Node >= 22.18 (native TypeScript type stripping) — just run:  node tests/rules.test.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";

const mod = await import(new URL("../extensions/rules.ts", import.meta.url));

// ---- fake pi API ----
const handlers = {};
const commands = {};
const fakePi = {
  on: (name, h) => { handlers[name] = h; },
  registerCommand: (name, opts) => { commands[name] = opts; },
};
mod.default(fakePi);

const beforeAgentStart = handlers["before_agent_start"];
if (!beforeAgentStart) throw new Error("before_agent_start handler not registered");

// ---- helpers ----
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ FAIL: ${msg}`); }
}

const TMP = join(fileURLToPath(new URL(".", import.meta.url)), ".work");
// rules.ts displays paths under $HOME as ~/... — mirror that for source-slice offsets
const disp = (p) => p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, "docs/patterns"), { recursive: true });
mkdirSync(join(TMP, "docs/nested/deep"), { recursive: true });

// Make the test hermetic: point the global rules file at a temp location.
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(TMP, "agent-dir");

function inject(cwd) {
  return beforeAgentStart({ systemPrompt: "BASE" }, { cwd });
}

// ================= Test 1: no RULES.md =================
console.log("Test 1: no RULES.md → no injection");
{
  const r = await inject(TMP);
  assert(r === undefined, "no injection when no RULES.md exists");
}

// ================= Test 2: init template + comment stripping =================
console.log("Test 2: /rules init creates template; expansion strips all comments");
{
  const ui = { notify: () => {}, setWidget: () => {} };
  await commands.rules.handler("init", { cwd: TMP, hasUI: false, mode: "tui", ui, reload: async () => {} });
  const tmpl = readFileSync(join(TMP, "RULES.md"), "utf-8");
  assert(tmpl.includes("RULES.md — user-maintained ground truth"), "template written");
  // the header comment must not contain nested <!-- --> markers: CommonMark
  // ends the comment at the FIRST -->, which would leak the cheat sheet text
  // into markdown previews (regression guard for the &lt;!-- fix)
  const headerEnd = tmpl.indexOf("--&gt;");
  const header = tmpl.slice(0, headerEnd);
  assert(!header.includes("<!--", 4), "no nested comment markers inside the header comment");
  assert(tmpl.includes("&lt;!--"), "syntax example uses HTML entities")

  const r = await inject(TMP);
  assert(r.systemPrompt.startsWith("BASE"), "base preserved");
  const g = r.systemPrompt.slice("BASE\n\n".length);
  assert(g.includes("<rules_ground_truth>"), "ground truth wrapper present");
  assert(g.includes("user-maintained ground-truth"), "preamble present");
  assert(!g.includes("<!--"), "no comments leaked into prompt");
  assert(!g.includes("@import docs/"), "template's example imports not expanded");
  assert(!g.includes("Syntax:"), "syntax cheat-sheet not in prompt");
  assert(g.includes("<rules_source path="), "source block present");
  const content = g.slice(g.indexOf("<rules_source") + `<rules_source path="${disp(TMP)}/RULES.md">`.length, g.indexOf("</rules_source>"));
  assert(!content.includes("Example"), "example comments stripped");
}

// ================= Test 3: imports =================
console.log("Test 3: whole-file, section, glob, nested, escape, missing");
{
  writeFileSync(join(TMP, "docs/conventions.md"), "# Conventions\n\n- tabs, not spaces\n");
  writeFileSync(join(TMP, "docs/architecture.md"), "# Architecture\n\n## Data Flow\n\nflow A → B\n\n## Deployment\n\ndeploy X\n");
  writeFileSync(join(TMP, "docs/patterns/one.md"), "# Pattern One\n\n- p1\n");
  writeFileSync(join(TMP, "docs/patterns/two.md"), "# Pattern Two\n\n- p2\n");
  writeFileSync(join(TMP, "docs/nested/deep/lib.md"), "# Lib\n\n- lib stuff\n");
  writeFileSync(join(TMP, "docs/nested/helper.md"), "# Helper\n\n@import deep/lib.md\n- helper stuff\n");

  writeFileSync(join(TMP, "RULES.md"), [
    "<!-- header comment -->",
    "",
    "# My Rules",
    "",
    "## Decisions",
    "- use pnpm",
    "",
    "\\@import docs/should-not-expand.md",
    "",
    "@import docs/conventions.md",
    "",
    "@import docs/architecture.md#Data Flow",
    "",
    "@import docs/patterns/*.md",
    "",
    "@import docs/nested/*.md",
    "",
    "@import docs/missing-file.md",
    "",
    "@import docs/empty-*.md",
    "",
    "```",
    "@import docs/inside-fence.md",
    "```",
    "",
    "## Intent",
    "- split into packages",
  ].join("\n"));

  const r = await inject(TMP);
  const g = r.systemPrompt;
  assert(g.includes("- use pnpm"), "plain rule kept");
  assert(g.includes("- tabs, not spaces"), "whole-file import expanded");
  assert(g.includes("flow A → B"), "section import expanded");
  assert(!g.includes("## Deployment"), "section import stops at next same-level heading");
  assert(g.includes("- p1") && g.includes("- p2"), "glob import expanded both files");
  assert(g.includes("lib stuff"), "nested import (relative to importing file) expanded");
  assert(!g.includes("[rules] skipped: docs/should-not-expand.md"), "escaped @import not treated as import");
  assert(g.includes("@import docs/should-not-expand.md"), "escaped line kept as literal text");
  assert(g.includes("[rules] skipped: docs/missing-file.md (file not found)"), "missing file marked");
  assert(g.includes("glob matched no files"), "empty glob marked");
  assert(!g.includes("[rules] skipped: docs/inside-fence.md"), "import inside code fence not expanded");

  // stripped comments leave blank lines behind; they must be trimmed at the edges
  const srcContent = g.slice(g.indexOf("<rules_source") + `<rules_source path="${disp(TMP)}/RULES.md">`.length, g.indexOf("</rules_source>")).trim();
  assert(srcContent.startsWith("# My Rules"), "leading blank lines trimmed");
  assert(srcContent.endsWith("- split into packages"), "trailing blank lines trimmed");
}

// ================= Test 4: cycle detection =================
console.log("Test 4: circular imports detected");
{
  writeFileSync(join(TMP, "a.md"), "# A\n\n@import b.md\n");
  writeFileSync(join(TMP, "b.md"), "# B\n\n@import a.md\n");
  writeFileSync(join(TMP, "RULES.md"), "@import a.md\n");
  const r = await inject(TMP);
  assert(r.systemPrompt.includes("circular import"), "cycle marked in output");
}

// ================= Test 5: dedup =================
console.log("Test 5: same file imported twice → deduped");
{
  writeFileSync(join(TMP, "RULES.md"), "@import docs/conventions.md\n@import docs/conventions.md\n");
  const r = await inject(TMP);
  const count = r.systemPrompt.split("tabs, not spaces").length - 1;
  assert(count === 1, `content included once (found ${count})`);
}

// ================= Test 6: depth limit =================
console.log("Test 6: depth limit");
{
  for (let i = 1; i <= 8; i++) writeFileSync(join(TMP, `l${i}.md`), `# L${i}\n\n@import l${i + 1}.md\n`);
  writeFileSync(join(TMP, "RULES.md"), "@import l1.md\n");
  const r = await inject(TMP);
  assert(r.systemPrompt.includes("max depth 5 exceeded"), "depth exceeded marked");
  assert(r.systemPrompt.includes("# L5"), "depth-5 content included");
  assert(!r.systemPrompt.includes("# L6"), "depth-6 content excluded");
}

// ================= Test 7: cache freshness =================
console.log("Test 7: cache invalidation on change");
{
  writeFileSync(join(TMP, "docs/conventions.md"), "# Conventions\n\n- tabs, not spaces\n");
  writeFileSync(join(TMP, "RULES.md"), "@import docs/conventions.md\n");
  const r1 = await inject(TMP);
  assert(r1.systemPrompt.includes("tabs, not spaces"), "first load ok");
  writeFileSync(join(TMP, "docs/conventions.md"), "# Conventions\n\n- UPDATED CONTENT\n");
  const r2 = await inject(TMP);
  assert(r2.systemPrompt.includes("UPDATED CONTENT"), "change picked up without reload");
}

// ================= Test 8: unclosed comment warning =================
console.log("Test 8: unclosed comment");
{
  writeFileSync(join(TMP, "RULES.md"), "- rule one\n\n<!-- never closed\n\n- rule two\n");
  const r = await inject(TMP);
  assert(!r.systemPrompt.includes("- rule two"), "rest of file treated as comment");
}

// ================= Test 9: nested comment with <!-- inside =================
console.log("Test 9: template-style header with <!-- example inside");
{
  writeFileSync(join(TMP, "RULES.md"), "<!-- header with <!-- nested example --> still comment -->\n\n- real rule\n");
  const r = await inject(TMP);
  assert(!r.systemPrompt.includes("nested example"), "nested-looking comment fully stripped");
  assert(r.systemPrompt.includes("- real rule"), "rule after comment kept");
}

// ================= Test 10: global rules file (via PI_CODING_AGENT_DIR) =================
console.log("Test 10: global RULES.md honored");
{
  const globalDir = join(TMP, "agent-dir");
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "RULES.md"), "- global rule\n");
  rmSync(join(TMP, "RULES.md"));
  const r = await inject(TMP);
  assert(r.systemPrompt.includes("- global rule"), "global rules loaded");
  assert(r.systemPrompt.includes("agent-dir/RULES.md"), "global source path shown");
}

// ================= Test 11: @rules settings =================
{
  rmSync(join(TMP, "agent-dir"), { recursive: true, force: true }); // no global rules
  for (let i = 1; i <= 4; i++) writeFileSync(join(TMP, `r${i}.md`), `# R${i}\n\n@import r${i + 1}.md\n`);
  writeFileSync(join(TMP, "RULES.md"), [
    "@rules max_depth 2",
    "@rules max_glob_files 1",
    "@rules max_total_bytes 100b",
    "@rules bogus 3",
    "@rules max_depth abc",
    "\\@rules max_depth 9  // escaped: literal, not applied",
    "@import r1.md",
  ].join("\n"));
  const r = await inject(TMP);
  const g = r.systemPrompt;
  assert(g.includes("# R1") && g.includes("# R2"), "depth-2 content included");
  assert(!g.includes("# R3"), "depth-3 content excluded (max_depth 2)");
  assert(g.includes("max depth 2 exceeded"), "depth error uses configured limit");
  assert(!g.includes("@rules max_depth 2"), "@rules directive lines not in prompt");
  assert(g.includes("max_depth 9"), "escaped @rules kept as literal text");
}


// ================= Test 12: @rules scoping in imported files =================
console.log("Test 12: @rules in imported files affects only their subtree");
{
  writeFileSync(join(TMP, "sub.md"), "@rules max_depth 1\n@import r1.md\n");
  writeFileSync(join(TMP, "RULES.md"), "@import sub.md\n@import r1.md\n");
  const r = await inject(TMP);
  const g = r.systemPrompt;
  // sub.md sets max_depth 1: r1 (depth 2 from sub) excluded;
  // RULES.md's own r1 import (depth 1) unaffected by sub's setting
  assert(g.includes("# R1"), "RULES.md's own import still works");
  assert(g.includes("max depth 1 exceeded"), "subtree limit applied inside sub.md");
}

// ================= Test 13: /rules show — preview + guard paths =================
{
  // buildPreviewBlocks: report first, then expanded content per source
  const fakeExp = {
    cwd: TMP,
    sources: [
      { path: "~/agent-dir/RULES.md", kind: "global", lines: 3, bytes: 9, content: "- global rule", imports: [] },
      { path: "RULES.md", kind: "project", lines: 12, bytes: 31, content: "- rule A\n@import expanded\n- rule B", imports: [{ spec: "docs/x.md", status: "ok", detail: "whole file", bytes: 22 }] },
    ],
    diagnostics: [{ level: "warning", message: 'RULES.md: unknown @rules key "bogus"' }],
    totalBytes: 40,
    generated: "",
    limits: { maxDepth: 2, maxGlobFiles: 1, maxTotalBytes: 100 },
    settings: [{ source: "RULES.md", key: "max_depth", value: "2" }],
    fileStats: new Map(),
  };
  const blocks = mod.buildPreviewBlocks(fakeExp);
  const all = blocks.segments.flatMap((s) => s.lines).join("\n");
  assert(blocks.title.includes("2 file(s) · 40 B · ~10 tokens"), "preview title shows stats");
  // report segment first (dim), without the duplicate "Rules:" stats line
  const reportSeg = blocks.segments[0];
  assert(reportSeg.style === "dim", "report segment styled dim");
  assert(!all.includes("Rules: 2 file(s)"), "stats line dropped (title carries it)");
  assert(reportSeg.lines[0].startsWith("limits:"), "report leads with limits");
  assert(all.includes("✓ @import docs/x.md — whole file · 22 B"), "import status in report");
  assert(all.includes("Settings (from RULES.md):") && all.includes("⚙ max_depth = 2 (RULES.md)"), "settings in report");
  assert(all.includes("Diagnostics:") && all.includes('unknown @rules key "bogus"'), "diagnostics in report");
  assert(all.includes("0 error(s) · 1 warning(s)"), "summary line present");
  // content segments: muted header + plain content
  const muted = blocks.segments.filter((s) => s.style === "muted");
  assert(muted.length === 2 && muted.every((s) => s.lines.length === 1), "one muted header per source");
  assert(muted[0].lines[0].includes("─ [global] ~/agent-dir/RULES.md — 3 lines · expanded 9 B"), "content header line present");
  const plain = blocks.segments.filter((s) => s.style === "plain");
  assert(plain.some((s) => s.lines.includes("- global rule")), "global content shown");
  assert(plain.some((s) => s.lines.includes("@import expanded")), "expanded content shown (imports inlined)");
  assert(all.includes("1 import(s)"), "import count noted");
  assert(mod.buildPreviewBlocks(undefined).segments.length === 0, "no rules → empty blocks");

  // makePreviewWindow: styled segments, borders, scrolling, clamp, close
  const fgCalls = [];
  const fakeTheme = { fg: (name, s) => { fgCalls.push(name); return s; } };
  const fakeTruncate = (t, w) => t.slice(0, w);
  const fakeVW = (t) => t.length;
  const fakeMK = (data, key) => data === key;
  const keys = { up: "up", down: "down", pageUp: "pageUp", pageDown: "pageDown", home: "home", end: "end", escape: "escape" };
  let renders = 0;
  let doneCalled = false;
  const tui = { terminal: { rows: 40 }, requestRender: () => { renders++; } };
  const wlines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  const segs = [
    { style: "dim", lines: ["meta 1", "meta 2"] },
    { style: "muted", lines: ["─ header"] },
    { style: "plain", lines: wlines },
  ];
  const win = mod.makePreviewWindow(tui, fakeTheme, () => { doneCalled = true; }, "T", segs, fakeTruncate, fakeVW, fakeMK, keys, false);
  const out = win.render(60);
  assert(out[0].startsWith("┌─") && out[0].endsWith("┐"), "top border with title");
  assert(out[out.length - 1].startsWith("└─") && out[out.length - 1].endsWith("┘"), "bottom border with status");
  assert(out[1].startsWith("│") && out[1].endsWith("│"), "content rows bordered");
  assert(out[1].includes("meta 1"), "first line is the report segment");
  assert(out[3].includes("─ header"), "muted header rendered");
  assert(out[4].includes("line 0"), "first content line shown");
  assert(out.length === 32, "window height = contentHeight + 2 borders (30+2)");
  assert(fgCalls.includes("dim") && fgCalls.includes("muted") && fgCalls.includes("accent"), "dim/muted/accent styles applied");

  win.handleInput("down");
  assert(renders === 1, "scroll triggers requestRender");
  assert(win.render(60)[4].includes("line 1"), "down scrolls one line");
  win.handleInput("end");
  assert(win.render(60)[4].includes("line 23"), "end clamps to last viewport (53-30)");
  win.handleInput("home");
  assert(win.render(60)[4].includes("line 0"), "home jumps to top");
  win.handleInput("up");
  assert(win.render(60)[4].includes("line 0"), "up at top clamps");
  win.handleInput("escape");
  assert(doneCalled, "escape closes window");

  // handler guard paths
  let n;
  // outside the TUI: falls back to the text report (what list used to print)
  await commands.rules.handler("show", { cwd: TMP, hasUI: false, mode: "rpc", ui: { notify: (m, t) => { n = [t, m]; } }, reload: async () => {} });
  assert(n[0] === "info" && n[1].includes("Rules: 1 file(s)"), "show outside TUI → text report");

  rmSync(join(TMP, "RULES.md"), { force: true });
  await commands.rules.handler("show", { cwd: TMP, hasUI: true, mode: "tui", ui: { notify: (m, t) => { n = [t, m]; }, custom: () => { throw new Error("custom must not run"); } }, reload: async () => {} });
  assert(n[1].includes("No RULES.md"), "show without rules → error notify");

  writeFileSync(join(TMP, "RULES.md"), "- fresh rule\n");
  let customRan = false;
  await commands.rules.handler("show", { cwd: TMP, hasUI: true, mode: "tui", ui: { notify: (m, t) => { n = [t, m]; }, custom: () => { customRan = true; } }, reload: async () => {} });
  assert(n[0] === "info" && n[1].includes("Rules: 1 file(s)"), "plain-Node lazy import fails → text report");
  assert(!customRan, "custom never invoked on degrade");
}

// restore env
if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = prevAgentDir;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
