// Regression test for extensions/rules.ts (39 assertions).
// Loads the real extension with a fake pi API — no network, no pi session, no npm deps.
// Works on any machine: sandbox lives under os.tmpdir(), outside any RULES.md ancestry.
// Requires Node >= 22.18 (native TypeScript type stripping) — just run:  node tests/rules.test.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

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

const TMP = join(tmpdir(), "pi-ext-rules-test");
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
    "@rules max_total_bytes 500b",
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

// ================= Test 13: /rules show — tree window + guard paths =================
{
  // buildRuleTree: sources as roots, settings/diagnostics as extra collapsed nodes
  const fakeExp = {
    cwd: TMP,
    sources: [
      { path: "~/agent-dir/RULES.md", kind: "global", lines: 3, bytes: 9, content: "- global rule", imports: [], tree: [{ id: "src:~/agent-dir/RULES.md/rules", kind: "content", label: "Rules (1)", lines: ["- global rule"] }] },
      { path: "RULES.md", kind: "project", lines: 12, bytes: 31, content: "- rule A\n@import expanded\n- rule B", imports: [{ spec: "docs/x.md", status: "ok", detail: "whole file", bytes: 22 }], tree: [
        { id: "src:RULES.md/rules", kind: "content", label: "Rules (2)", lines: ["- rule A", "- rule B"] },
        { id: "src:RULES.md/imp:0", kind: "import", label: "@import docs/x.md", status: "ok", meta: "whole file · 22 B", children: [{ id: "src:RULES.md/imp:0/rules", kind: "content", label: "Rules (1)", lines: ["- imported rule"] }] },
        { id: "src:RULES.md/imp:1", kind: "import", label: "@import docs/patterns/*.md", status: "ok", meta: "2 files · 45 B", children: [
          { id: "src:RULES.md/imp:1/f:0", kind: "import", label: "patterns/one.md", meta: "20 B", children: [{ id: "src:RULES.md/imp:1/f:0/rules", kind: "content", label: "Rules (1)", lines: ["- p1"] }] },
          { id: "src:RULES.md/imp:1/f:1", kind: "import", label: "patterns/two.md", meta: "25 B", children: [{ id: "src:RULES.md/imp:1/f:1/rules", kind: "content", label: "Rules (1)", lines: ["- p2"] }] },
        ] },
      ] },
    ],
    diagnostics: [{ level: "warning", message: 'RULES.md: unknown @rules key "bogus"' }],
    totalBytes: 40,
    generated: "",
    limits: { maxDepth: 2, maxGlobFiles: 1, maxTotalBytes: 100 },
    settings: [{ source: "RULES.md", key: "max_depth", value: "2" }],
    fileStats: new Map(),
  };
  const tree = mod.buildRuleTree(fakeExp);
  assert(tree.title.includes("2 file(s) · 40 B · ~10 tokens"), "tree title shows stats");
  assert(tree.header[0].startsWith("limits:"), "header leads with limits");
  assert(tree.roots.length === 4, "roots = 2 sources + settings + diagnostics");
  assert(tree.roots[1].label === "[project] RULES.md", "source node label carries kind + path");
  assert(tree.roots[2].kind === "settings" && tree.roots[2].lines[0] === "max_depth = 2 (RULES.md)", "settings node leaves");
  assert(tree.roots[3].kind === "diagnostics" && tree.roots[3].lines[0].includes('unknown @rules key "bogus"'), "diagnostics node leaves");
  assert(mod.buildRuleTree(undefined).roots.length === 0, "no rules → empty tree");

  // makeRuleTreeWindow: borders, header, tree lines, fold/unfold, selection, close
  const fgCalls = [];
  const fakeTheme = { fg: (name, s) => { fgCalls.push(name); return s; } };
  const fakeTruncate = (t, w) => t.slice(0, w);
  const fakeVW = (t) => t.length;
  const fakeMK = (data, key) => data === key;
  const keys = { up: "up", down: "down", pageUp: "pageUp", pageDown: "pageDown", home: "home", end: "end", fold: "left", unfold: "right", toggle: "enter", escape: "escape" };
  let doneCalled = false;
  const tui = { terminal: { rows: 40 }, requestRender: () => {} };
  const win = mod.makeRuleTreeWindow(tui, fakeTheme, () => { doneCalled = true; }, tree, fakeTruncate, fakeVW, fakeMK, keys, false);
  let out = win.render(60);
  const flatText = out.join("\n");
  assert(out[0].startsWith("┌─") && out[0].endsWith("┐"), "top border with title");
  assert(out[out.length - 1].startsWith("└─") && out[out.length - 1].endsWith("┘"), "bottom border with status");
  assert(out[1].includes("limits:"), "header line above the tree");
  assert(out[2].includes("[global] ~/agent-dir/RULES.md"), "first tree line is the global source");
  assert(out.length === 32, "window height = header + treeHeight + 2 borders");
  assert(fgCalls.includes("dim") && fgCalls.includes("accent"), "dim/accent styles applied");
  // default state: sources + Rules open, imports/settings/diagnostics collapsed
  assert(flatText.includes("- rule A") && flatText.includes("- rule B"), "inline rules visible by default");
  assert(flatText.includes("+ @import docs/x.md") && flatText.includes("+ @import docs/patterns/*.md"), "imports collapsed by default");
  assert(flatText.includes("+ Settings (1)") && flatText.includes("+ Diagnostics (1)"), "settings/diagnostics collapsed");

  // selection moves with up/down (footer shows sel+1 / total)
  assert(out[out.length - 1].includes("1 / 11"), "initial selection is the first line");
  win.handleInput("down");
  assert(win.render(60)[out.length - 1].includes("2 / 11"), "down moves selection");
  win.handleInput("down");
  win.handleInput("down");
  win.handleInput("down");
  win.handleInput("down");
  win.handleInput("down");
  win.handleInput("down");
  out = win.render(60);
  assert(out[out.length - 1].includes("8 / 11"), "selection reaches the import node");
  win.handleInput("right"); // unfold
  out = win.render(60);
  assert(out[out.length - 1].includes("8 / 13"), "unfold grows the tree");
  assert(out.join("\n").includes("- @import docs/x.md"), "import now expanded");
  win.handleInput("left"); // fold again
  assert(win.render(60)[out.length - 1].includes("8 / 11"), "fold shrinks the tree back");

  win.handleInput("end");
  assert(win.render(60)[out.length - 1].includes("11 / 11"), "end jumps to the last line");
  win.handleInput("home");
  assert(win.render(60)[out.length - 1].includes("1 / 11"), "home jumps back to the top");
  win.handleInput("up");
  assert(win.render(60)[out.length - 1].includes("1 / 11"), "up at top clamps");
  win.handleInput("escape");
  assert(doneCalled, "escape closes window");

  // toggle (enter) expands a collapsed node
  const win2 = mod.makeRuleTreeWindow(tui, fakeTheme, () => {}, tree, fakeTruncate, fakeVW, fakeMK, keys, false);
  win2.handleInput("down");
  win2.handleInput("down");
  win2.handleInput("down");
  win2.handleInput("down");
  win2.handleInput("down");
  win2.handleInput("down");
  win2.handleInput("down");
  assert(win2.render(60).join("\n").includes("+ @import docs/x.md"), "second window: import still collapsed");
  win2.handleInput("enter");
  assert(win2.render(60).join("\n").includes("- @import docs/x.md"), "enter expands the node");
  win2.handleInput("enter");
  assert(win2.render(60).join("\n").includes("+ @import docs/x.md"), "enter collapses the node again");

  // glob imports: each matched file is a path-labeled child node
  win2.handleInput("down"); // move to the glob import
  win2.handleInput("right"); // unfold it
  const globView = win2.render(60).join("\n");
  assert(globView.includes("+ patterns/one.md") && globView.includes("+ patterns/two.md"), "glob children carry per-file paths");

  // handler guard paths
  let n;
  // outside the TUI: falls back to the text report
  await commands.rules.handler("show", { cwd: TMP, hasUI: false, mode: "rpc", ui: { notify: (m, t) => { n = [t, m]; } }, reload: async () => {} });
  assert(n[0] === "info" && n[1].includes("Rules: 1 file(s)"), "show outside TUI → text report");

  rmSync(join(TMP, "RULES.md"), { force: true });
  await commands.rules.handler("show", { cwd: TMP, hasUI: true, mode: "tui", ui: { notify: (m, t) => { n = [t, m]; }, custom: () => { throw new Error("custom must not run"); } }, reload: async () => {} });
  assert(n[1].includes("No RULES.md"), "show without rules → error notify");

  writeFileSync(join(TMP, "RULES.md"), "- fresh rule\n");
  // The lazy pi-tui import only resolves when @earendil-works/pi-tui is
  // installed (devDependency). Probe it so both states are covered: with it
  // the custom window path runs; without it rules degrades to the text
  // report (the original plain-Node behavior).
  let piTuiResolvable = false;
  try {
    await import("@earendil-works/pi-tui");
    piTuiResolvable = true;
  } catch {
    // pi-tui not installed (fresh clone): the degrade branch below covers it
  }
  let customRan = false;
  await commands.rules.handler("show", { cwd: TMP, hasUI: true, mode: "tui", ui: { notify: (m, t) => { n = [t, m]; }, custom: () => { customRan = true; } }, reload: async () => {} });
  if (piTuiResolvable) {
    assert(customRan, "custom window invoked when pi-tui resolves");
  } else {
    assert(n[0] === "info" && n[1].includes("Rules: 1 file(s)"), "plain-Node lazy import fails → text report");
    assert(!customRan, "custom never invoked on degrade");
  }
}

// ================= Test 14: tilde and absolute glob patterns =================
console.log("Test 14: ~/ and absolute glob imports resolve their base dirs");
{
  const prevHome = process.env.HOME;
  process.env.HOME = TMP; // ~ expands to $HOME at call time
  try {
    writeFileSync(join(TMP, "RULES.md"), "@import ~/docs/patterns/*.md\n");
    let r = await inject(TMP);
    assert(r.systemPrompt.includes("- p1") && r.systemPrompt.includes("- p2"), "~/ glob expanded from $HOME");

    writeFileSync(join(TMP, "RULES.md"), `@import ${TMP}/docs/patterns/*.md\n`);
    r = await inject(TMP);
    assert(r.systemPrompt.includes("- p1") && r.systemPrompt.includes("- p2"), "absolute glob expanded");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
}

// ================= Test 15: hard limits (glob cap + byte cap) =================
console.log("Test 15: max_glob_files and max_total_bytes are hard caps");
{
  writeFileSync(join(TMP, "RULES.md"), "@rules max_glob_files 1\n@import docs/patterns/*.md\n");
  const g1 = (await inject(TMP)).systemPrompt;
  assert(g1.includes("- p1") && !g1.includes("- p2"), "glob capped: only the first matched file expanded");
  assert(g1.includes("glob limit 1 exceeded"), "capped files marked in the prompt");

  writeFileSync(join(TMP, "RULES.md"), "@rules max_total_bytes 100\n- rule one: alpha\n- rule two: beta\n- rule three: gamma\n- rule four: delta\n- rule five: echo\n- rule six: foxtrot\n- rule seven: golf\n- rule eight: hotel\n");
  const g2 = (await inject(TMP)).systemPrompt;
  assert(g2.includes("- rule one: alpha"), "content before the cut kept");
  assert(!g2.includes("- rule eight"), "content beyond the cap dropped");
  assert(g2.includes("[rules] truncated"), "cut marked in the prompt");
}

// ================= Test 16: glob cache invalidates on new files ================
console.log("Test 16: new files matching a glob invalidate the cache");
{
  writeFileSync(join(TMP, "RULES.md"), "@import docs/patterns/*.md\n");
  const g1 = (await inject(TMP)).systemPrompt;
  assert(g1.includes("- p1") && g1.includes("- p2"), "initial glob expansion");
  writeFileSync(join(TMP, "docs/patterns/three.md"), "- p3\n");
  const g2 = (await inject(TMP)).systemPrompt;
  assert(g2.includes("- p3"), "new file under the glob picked up without reload");

  // nested ** glob: a new file in a subdirectory invalidates too
  writeFileSync(join(TMP, "RULES.md"), "@import docs/nested/**/*.md\n");
  const g3 = (await inject(TMP)).systemPrompt;
  assert(g3.includes("helper stuff") && g3.includes("lib stuff"), "recursive glob expansion");
  writeFileSync(join(TMP, "docs/nested/deep/new.md"), "- deep new\n");
  const g4 = (await inject(TMP)).systemPrompt;
  assert(g4.includes("- deep new"), "new file in a nested dir picked up");

  // empty glob: creating the directory later invalidates too
  writeFileSync(join(TMP, "RULES.md"), "@import docs/gone/*.md\n");
  const g5 = (await inject(TMP)).systemPrompt;
  assert(g5.includes("glob matched no files"), "empty glob reported");
  mkdirSync(join(TMP, "docs/gone"), { recursive: true });
  writeFileSync(join(TMP, "docs/gone/a.md"), "- arrived\n");
  const g6 = (await inject(TMP)).systemPrompt;
  assert(g6.includes("- arrived"), "later-created glob dir picked up");
}

// ================= Test 17: section imports expand nested directives ==========
console.log("Test 17: section imports expand nested @import/@rules");
{
  writeFileSync(join(TMP, "docs/sections.md"), [
    "# Sections",
    "",
    "## Data",
    "",
    "@import patterns/one.md",
    "",
    "- local rule",
    "",
    "## Other",
    "",
    "- untouched",
  ].join("\n"));
  writeFileSync(join(TMP, "RULES.md"), "@import docs/sections.md#Data\n");
  const g = (await inject(TMP)).systemPrompt;
  assert(g.includes("- p1"), "nested import inside the section expanded");
  assert(g.includes("- local rule"), "section content kept");
  assert(!g.includes("- untouched"), "other sections not included");
  assert(!g.includes("@import patterns/one.md"), "directive line consumed, not left literal");

  // cycles through sections are detected
  writeFileSync(join(TMP, "cyc.md"), "## S\n\n@import cyc.md#S\n");
  writeFileSync(join(TMP, "RULES.md"), "@import cyc.md#S\n");
  const g2 = (await inject(TMP)).systemPrompt;
  assert(g2.includes("circular import"), "section self-import reported as circular");

  // @rules inside a section apply only to the section subtree
  writeFileSync(join(TMP, "sec.md"), "## S\n\n@rules max_depth 1\n@import r1.md\n");
  writeFileSync(join(TMP, "RULES.md"), "@import sec.md#S\n");
  const g3 = (await inject(TMP)).systemPrompt;
  assert(g3.includes("max depth 1 exceeded"), "section-local limit applied");
}
// ================= Test 18: @import-if conditional imports =================
console.log("Test 18: @import-if conditional imports");
{
  process.env.RULES_IF_TEST = "1";
  process.env.RULES_IF_EMPTY = "";
  delete process.env.RULES_IF_GONE;
  process.env.RULES_IF_EQ = "a=b";
  mkdirSync(join(TMP, "docs/globs"), { recursive: true });
  writeFileSync(join(TMP, "docs/oscheck.md"), "- os matched\n");
  writeFileSync(join(TMP, "docs/negos.md"), "- negos matched\n");
  writeFileSync(join(TMP, "docs/negos2.md"), "- negos2 matched\n");
  writeFileSync(join(TMP, "docs/eq.md"), "- eq matched\n");
  writeFileSync(join(TMP, "docs/globs/a.md"), "- ga\n");
  writeFileSync(join(TMP, "docs/globs/b.md"), "- gb\n");
  writeFileSync(join(TMP, "docs/condsub.md"), "# CondSub\n\n@import-if env:RULES_IF_GONE patterns/two.md\n- sub stuff\n");
  writeFileSync(join(TMP, "RULES.md"), [
    "@import-if env:RULES_IF_TEST docs/conventions.md",
    "@import-if env:RULES_IF_GONE docs/architecture.md#Data Flow",
    "@import-if !env:RULES_IF_GONE docs/patterns/*.md",
    "@import-if env:RULES_IF_TEST=1 docs/nested/helper.md",
    "@import-if env:RULES_IF_TEST docs/condsub.md",
    "@import-if env:RULES_IF_EMPTY docs/missing-a.md",
    "@import-if bogus docs/missing-b.md",
    "@import-if os:definitely-not-a-platform docs/oscheck.md",
    `@import-if os:${process.platform} docs/oscheck.md`,
    "@import-if !os:definitely-not-a-platform docs/negos.md",
    "@import-if env:RULES_IF_EQ=a=b docs/eq.md",
    "@import-if env:RULES_IF_TEST docs/missing-c.md",
    "@rules max_glob_files 1",
    "@import-if env:RULES_IF_TEST docs/globs/*.md",
    "\\@import-if env:RULES_IF_GONE docs/literal.md",
  ].join("\n"));
  const g = (await inject(TMP)).systemPrompt;
  assert(g.includes("UPDATED CONTENT"), "env set -> import expanded");
  assert(!g.includes("flow A → B"), "env unset -> import skipped silently");
  assert(g.includes("- p1") && g.includes("- p2"), "negated condition imports when env unset");
  assert(g.includes("helper stuff"), "env:VAR=value exact match imports");
  assert(g.includes("- sub stuff"), "nested @import-if inside an imported file works");
  assert(g.includes("- negos matched"), "!os: (impossible platform) imports");
  assert(!g.includes("negos2"), "!os: (current platform) skipped");
  assert(g.includes("- eq matched"), "env:VAR=value with = in the value imports");
  assert(!g.includes("missing-a"), "empty env treated as unset");
  assert(!g.includes("missing-b"), "invalid condition -> skipped");
  assert(g.includes("[rules] skipped: docs/missing-c.md (file not found)"), "matched import with missing file reports like @import");
  assert(g.includes("glob limit 1 exceeded"), "@rules max_glob_files applies to @import-if globs");
  assert(g.includes("- ga") && !g.includes("- gb"), "capped @import-if glob imports only the first file");
  assert(g.includes("@import-if env:RULES_IF_GONE docs/literal.md"), "escaped @import-if kept as literal");
  assert(g.includes("os matched"), "current-platform os: condition imports");
  assert(g.split("- os matched").length - 1 === 1, "matching os: import deduped (skipped line contributes nothing)");
  // env change invalidates the cache (condition results are part of the cache key)
  process.env.RULES_IF_GONE = "1";
  const g2 = (await inject(TMP)).systemPrompt;
  assert(g2.includes("flow A → B"), "newly matching condition picked up without reload");
  assert(!g2.includes("- p3"), "newly failing condition dropped without reload");
  assert(g2.includes("- p2"), "nested @import-if flips when the env changes");

  // report lists skips, the invalid-condition diagnostic, and the import-if directive
  let n;
  await commands.rules.handler("show", { cwd: TMP, hasUI: false, mode: "rpc", ui: { notify: (m, t) => { n = [t, m]; } }, reload: async () => {} });
  assert(n[1].includes("[skip]"), "skipped imports listed in the report");
  assert(n[1].includes("invalid condition"), "invalid condition surfaces as a diagnostic");
  assert(n[1].includes("@import-if env:RULES_IF_TEST"), "diagnostics carry the full @import-if directive");

  // value comparison change invalidates the cache too
  process.env.RULES_IF_EQ = "a=c";
  const g3 = (await inject(TMP)).systemPrompt;
  assert(!g3.includes("- eq matched"), "env:VAR=value change picked up without reload");
  assert(g3.includes("- sub stuff"), "unrelated conditions unaffected");

  delete process.env.RULES_IF_TEST;
  delete process.env.RULES_IF_EMPTY;
  delete process.env.RULES_IF_EQ;
  delete process.env.RULES_IF_GONE;
}
console.log("Test 19: ancestor RULES.md lookup");
{
  const deep = join(TMP, "sub/deep");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(TMP, "RULES.md"), "- root rule\n");
  const r1 = await inject(deep);
  assert(r1.systemPrompt.includes("- root rule"), "RULES.md found in an ancestor dir");
  writeFileSync(join(deep, "RULES.md"), "- deep rule\n");
  const r2 = await inject(deep);
  assert(r2.systemPrompt.includes("- root rule") && r2.systemPrompt.includes("- deep rule"), "all ancestor RULES.md files apply");
  writeFileSync(join(TMP, "sub/RULES.md"), "- sub rule\n");
  const r3 = await inject(deep);
  assert(r3.systemPrompt.includes("- sub rule"), "RULES.md created in a new ancestor picked up without reload");
  rmSync(join(TMP, "RULES.md"), { force: true });
  rmSync(join(deep, "RULES.md"), { force: true });
  rmSync(join(TMP, "sub/RULES.md"), { force: true });
}

// restore env
if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = prevAgentDir;

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
