// Regression test for extensions/skim.ts.
// Loads the real extension with a fake pi API — no network, no pi session, no npm deps.
// Requires Node >= 22.18 (native TypeScript type stripping) — just run:  node tests/skim.test.mjs

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const mod = await import(new URL("../extensions/skim.ts", import.meta.url));

// ---- fake pi API ----
const handlers = {};
const commands = {};
const tools = {};
const fakePi = {
	on: (name, h) => { handlers[name] = h; },
	registerCommand: (name, opts) => { commands[name] = opts; },
	registerTool: (def) => { tools[def.name] = def; },
};
await mod.default(fakePi);

let pass = 0, fail = 0;
function assert(cond, msg) {
	if (cond) { pass++; console.log(`  ✓ ${msg}`); }
	else { fail++; console.log(`  ✗ FAIL: ${msg}`); }
}

const TMP = join(fileURLToPath(new URL(".", import.meta.url)), ".work");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, "src"), { recursive: true });
mkdirSync(join(TMP, "node_modules"), { recursive: true });

// ================= Test 1: TS outline =================
console.log("Test 1: TS outline — symbols, kinds, spans, descriptions");
{
	const src = [
		"// ====== separator ======",
		"/** Docs for alpha. */",
		"export function alpha(a: string): { ok: boolean } {",
		'  const x = { a: 1 };',
		'  return { ok: true };',
		"}",
		"",
		"class Beta {",
		"  constructor() {}",
		"  private helper(): void {",
		"    if (true) { return; }",
		"  }",
		"  async run(): Promise<void> {",
		'    const t = `tpl ${"{"} x ${"}"}`;',
		"  }",
		"}",
		"",
		"interface Gamma {",
		"  name: string;",
		"}",
		"",
		"type Delta = { id: number };",
		"",
		"const Epsilon = () => { return 42; };",
		"",
		"export default function () { return 1; }",
		"",
		"function oneLiner() { return 1; }",
		"",
		"function multiLine(",
		"  a: number,",
		"): number {",
		"  return a + 1;",
		"}",
	].join("\n").split("\n");
	const syms = mod.outlineFor(src, "ts");
	const byName = Object.fromEntries(syms.map((s) => [s.name, s]));

	assert(syms.length === 11, `11 symbols found (got ${syms.length})`);
	assert(byName["alpha"]?.kind === "function" && byName["alpha"].line === 3, "alpha: function @3");
	assert(byName["alpha"].endLine === 6, "alpha spans to line 6 (return type { ok } not mistaken for body)");
	assert(byName["alpha"].desc === "Docs for alpha.", "alpha docblock extracted as desc");
	assert(byName["Beta"]?.kind === "class", "Beta: class");
	assert(byName["helper"]?.kind === "method" && byName["helper"].depth === 1, "helper: nested method");
	assert(byName["constructor"]?.kind === "method", "constructor counted as method");
	assert(byName["run"]?.endLine === 15, "run body ends before class close (template literal braces ignored)");
	assert(byName["Gamma"]?.kind === "interface", "Gamma: interface");
	assert(byName["Delta"]?.kind === "type", "Delta: type");
	assert(byName["Epsilon"]?.kind === "const", "Epsilon: const");
	assert(byName["default"]?.kind === "function", "anonymous default export named 'default'");
	assert(byName["oneLiner"]?.endLine === 28, "one-liner spans its single line");
	assert(byName["multiLine"]?.endLine === 34, "multi-line signature body found (line 34)");
	assert(byName["alpha"].desc !== undefined && !byName["alpha"].desc.includes("====="), "separator lines not used as desc");
}

// ================= Test 2: --read (symbol + line) =================
console.log("Test 2: readSymbol — by name and by line number");
{
	const src = [
		"function foo() {",
		"  return 1;",
		"}",
		"",
		"function bar(): { x: number } {",
		"  return { x: 2 };",
		"}",
	].join("\n").split("\n");
	const r = mod.readSymbol(src, "ts", "bar");
	assert(r !== null && r.line === 5 && r.endLine === 7, "bar read spans 5-7");
	assert(r.text.includes("return { x: 2 }"), "body content included");
	const r2 = mod.readSymbol(src, "ts", 1);
	assert(r2 !== null && r2.line === 1 && r2.endLine === 3, "line 1 reads the foo block");
	const r3 = mod.readSymbol(src, "ts", "missing-symbol");
	assert(r3 === null, "unknown symbol → null");
}

// ================= Test 3: markdown =================
console.log("Test 3: markdown outline — fences and comments skipped");
{
	const md = [
		"# Title",
		"intro",
		"```",
		"# not a heading",
		"```",
		"## Section A",
		"text a",
		"### Sub",
		"<!--",
		"## hidden",
		"-->",
		"# Next",
	].join("\n").split("\n");
	const syms = mod.outlineFor(md, "md");
	const names = syms.map((s) => `${s.kind}:${s.name}`);
	assert(names.join("|") === "h1:Title|h2:Section A|h3:Sub|h1:Next", `headings only (got ${names.join("|")})`);
	assert(syms[0].endLine === 11, "Title spans until Next");
	const r = mod.readSymbol(md, "md", "Section A");
	assert(r !== null && r.line === 6 && r.endLine === 11, "Section A section read (h2 includes its h3)");
}

// ================= Test 4: JSON =================
console.log("Test 4: JSON outline — top-level keys with types and spans");
{
	const json = [
		"{",
		'  "name": "pi",',
		'  "version": "0.4.3",',
		'  "scripts": {',
		'    "test": "node tests/run-all.mjs"',
		"  },",
		'  "arr": [1, 2, 3]',
		"}",
	].join("\n").split("\n");
	const syms = mod.outlineFor(json, "json");
	const byName = Object.fromEntries(syms.map((s) => [s.name, s]));
	assert(syms.length === 4, `4 keys (got ${syms.length})`);
	assert(byName["name"]?.kind === "string" && byName["name"].line === 2, "name: string @2");
	assert(byName["scripts"]?.kind === "object" && byName["scripts"].endLine === 6, "scripts: object spans 4-6");
	assert(byName["arr"]?.kind === "array", "arr: array");
}

// ================= Test 5: directory map =================
console.log("Test 5: skimDir — entry files first, junk skipped");
{
	writeFileSync(join(TMP, "package.json"), '{"name":"x"}');
	writeFileSync(join(TMP, "README.md"), "# README");
	writeFileSync(join(TMP, "src", "index.ts"), "export function main() { return 1; }\n");
	writeFileSync(join(TMP, "src", "util.ts"), "// helper\nconst x = 1;\n");
	writeFileSync(join(TMP, "node_modules", "junk.js"), "junk");
	writeFileSync(join(TMP, ".hidden"), "h");
	const dir = mod.skimDir(TMP, 2);
	assert(dir.skipped === 2, `node_modules + .hidden skipped (got ${dir.skipped})`);
	const first = dir.entries[0];
	assert(first.path === "package.json" && first.entry, "package.json first (entry file)");
	const readme = dir.entries.find((e) => e.path === "README.md");
	assert(readme.first === "# README", "md heading counts as first line");
	const util = dir.entries.find((e) => e.path.endsWith("util.ts"));
	assert(util.first === "const x = 1;", "comment-only first lines skipped");
	const txt = mod.formatDir(dir);
	assert(txt.includes("* package.json"), "formatDir marks entry files with *");
}

// ================= Test 6: glob =================
console.log("Test 6: expandGlob — *, **, ?");
{
	const G = join(TMP, "globdir");
	mkdirSync(join(G, "src", "deep"), { recursive: true });
	writeFileSync(join(G, "src", "a.ts"), "a");
	writeFileSync(join(G, "src", "deep", "b.ts"), "b");
	writeFileSync(join(G, "src", "deep", "c.txt"), "c");
	const g1 = mod.expandGlob("src/*.ts", G);
	assert(g1.length === 1 && g1[0].endsWith("a.ts"), "src/*.ts → a.ts only");
	const g2 = mod.expandGlob("src/**/*.ts", G);
	assert(g2.length === 2, "src/**/*.ts → a.ts + b.ts");
	const g3 = mod.expandGlob("src/**/*.?s", G);
	assert(g3.length === 2, "? matches one char");
}

// ================= Test 7: runSkim tool paths =================
console.log("Test 7: runSkim — outline, read, filter, json, errors");
{
	const file = join(TMP, "src", "index.ts");
	const out = await mod.runSkim({ path: file }, TMP);
	assert(out.startsWith("index.ts ("), "outline header");
	assert(out.includes("function main @"), "symbol listed");
	const out2 = await mod.runSkim({ path: file, read: "main" }, TMP);
	assert(out2.includes("return 1"), "read symbol body returned");
	const out3 = await mod.runSkim({ path: file, filter: "main" }, TMP);
	assert(out3.includes("main") && !out3.includes("util"), "filter narrows symbols");
	const out4 = await mod.runSkim({ path: file, json: true }, TMP);
	assert(JSON.parse(out4).symbols.length > 0, "json mode parses");
	const out5 = await mod.runSkim({ path: join(TMP, "nope.ts") }, TMP).catch((e) => e.message);
	assert(typeof out5 === "string" && out5.includes("not found"), "missing path errors");
	const out6 = await mod.runSkim({ path: "src/*.ts", filter: "main" }, TMP);
	assert(out6.includes("index.ts"), "glob + filter works");
}

// ================= Test 8: cache + binary + size guards =================
console.log("Test 8: guards — binary, oversized, cache freshness");
{
	const bin = join(TMP, "blob.bin");
	writeFileSync(bin, Buffer.from([0, 1, 2, 3, 255]));
	try {
		mod.skimFile(bin);
		assert(false, "binary file rejected");
	} catch (e) {
		assert(String(e.message).includes("binary"), "binary file rejected");
	}
	writeFileSync(join(TMP, "big.txt"), "x".repeat(1024 * 1024 + 10));
	try {
		mod.skimFile(join(TMP, "big.txt"));
		assert(false, "oversized file rejected");
	} catch (e) {
		assert(String(e.message).includes("too large"), "oversized file rejected");
	}
	// cache: same mtime+size returns cached; write changes it
	const f = join(TMP, "cache.ts");
	writeFileSync(f, "function a() {}\n");
	const r1 = mod.runSkim({ path: f }, TMP);
	writeFileSync(f, "function a() {}\nfunction b() {}\n");
	const r2 = mod.runSkim({ path: f }, TMP);
	assert((await r1) !== (await r2) && (await r2).includes("b"), "cache invalidated on change");
}

// ================= Test 9: registration =================
console.log("Test 9: extension registers tool + command");
{
	assert(typeof tools["skim"] === "object", "skim tool registered");
	assert(typeof commands["skim"] === "object", "skim command registered");
	assert(tools["skim"].description.includes("outline"), "tool description present");
	// command handler outside TUI
	const notified = [];
	await commands["skim"].handler("", { ui: { notify: (m) => notified.push(m) } });
	assert(notified.length === 1 && notified[0].includes("Usage"), "empty args shows usage");
}

// ================= Test 10: regex literals, ascii output, kinds =================
console.log("Test 10: regex literals do not break spans; output is pure ASCII");
{
	const src = [
		"/** Doc with regexes. */",
		"function rex() {",
		'  const a = /\\d{2}/;',
		'  const b = /[{}\\[\\]]+/;',
		'  const c = /"quoted"/g;',
		'  if (a.test("x")) return { ok: true };',
		"}",
		"",
		"export default async function named() {",
		"  return 1;",
		"}",
	].join("\n").split("\n");
	const syms = mod.outlineFor(src, "ts");
	const byName = Object.fromEntries(syms.map((s) => [s.name, s]));
	assert(byName["rex"]?.endLine === 7, `regex literals do not break spans (rex ends at 7, got ${byName["rex"]?.endLine})`);
	assert(byName["named"]?.kind === "function", "export default async function -> kind function");
	assert(byName["rex"].desc === "Doc with regexes.", "docblock desc not polluted by closing */");
	const outline = mod.formatOutline({ path: "f.ts", lang: "ts", lines: src.length, bytes: 200, symbols: syms }, {});
	// eslint-disable-next-line no-control-regex
	assert(!/[^\x00-\x7F]/.test(outline), "outline output is pure ASCII");
	assert(outline.includes("lines |") && !outline.includes("行"), "English units in header");
}

// ================= Test 11: bare dirs at depth limit, filter guard, desc first line =================
console.log("Test 11: bare dirs at depth limit, filter guard, first-line desc");
{
	const d1 = mod.skimDir(TMP, 1);
	const srcDir = d1.entries.find((e) => e.path === "src");
	assert(srcDir !== undefined && srcDir.dir === true, "depth 1 lists src/ as a bare dir entry");
	const flat = mod.formatDir(d1);
	assert(flat.includes("src/ (dir)"), "formatDir marks bare dirs");
	// eslint-disable-next-line no-control-regex
	assert(!/[^\x00-\x7F]/.test(flat), "dir output pure ASCII");
	let err = null;
	try {
		mod.formatOutline({ path: "f.ts", lang: "ts", lines: 1, bytes: 10, symbols: [] }, { filter: "[" });
	} catch (e) { err = e.message; }
	assert(typeof err === "string" && err.includes("invalid filter"), "invalid filter regex errors cleanly");
	// multi-line docblock: desc is the first (summary) line, not the last
	const src = [
		"/** First line summary.",
		" * Second line detail.",
		" */",
		"function two() { return 2; }",
	].join("\n").split("\n");
	const syms = mod.outlineFor(src, "ts");
	const two = syms.find((s) => s.name === "two");
	assert(two?.desc === "First line summary.", `desc is the first docblock line (got ${two?.desc})`);
}

// ================= Test 12: TS re-export =================
console.log("Test 12: TS re-export — export { } from / export * from / export * as ns");
{
	const src = [
		'export { a, b } from "./mod1";',
		'export * from "./mod2";',
		'export * as ns from "./mod3";',
		'export type { A } from "./mod4";',
		"export function real() { return 1; }",
	].join("\n").split("\n");
	const syms = mod.outlineFor(src, "ts");
	const byName = Object.fromEntries(syms.map((s) => [s.name, s]));
	assert(syms.length === 5, `5 symbols (4 re-exports + function, got ${syms.length})`);
	assert(byName["a, b"]?.kind === "re-export" && byName["a, b"].desc === "from ./mod1", "export { a, b } -> name 'a, b', desc 'from ./mod1'");
	assert(byName["*"]?.kind === "re-export" && byName["*"].desc === "from ./mod2", "export * -> name '*', desc 'from ./mod2'");
	assert(byName["ns"]?.kind === "re-export" && byName["ns"].desc === "from ./mod3", "export * as ns -> name 'ns'");
	assert(byName["A"]?.kind === "re-export" && byName["A"].desc === "from ./mod4", "export type { A } -> name 'A'");
	assert(byName["real"]?.kind === "function", "regular function still extracted");
}

// ================= Test 13: signature desc for comment-less decls =================
console.log("Test 13: signature desc — .d.ts-style methods without comments");
{
	const src = [
		"class Api {",
		"  constructor(options: { url: string }) {",
		"  }",
		"  /** Docs. */",
		"  get state(): string;",
		"  steer(message: string): void;",
		"}",
	].join("\n").split("\n");
	const syms = mod.outlineFor(src, "ts");
	const byName = Object.fromEntries(syms.map((s) => [s.name, s]));
	assert(byName["constructor"]?.desc === "constructor(options: { url: string })", `constructor desc = signature (got ${byName["constructor"]?.desc})`);
	assert(byName["state"]?.desc === "Docs.", "docblock wins over signature when present");
	assert(byName["steer"]?.desc === "steer(message: string): void", `steer desc = signature (got ${byName["steer"]?.desc})`);
}

// ================= Test 14: confidence note =================
console.log("Test 14: confidence — low-confidence outlines flagged, normal files not");
{
	const unknown = mod.formatOutline({ path: "f.xyz", lang: "unknown", lines: 3, bytes: 10, symbols: [{ name: "chunk", kind: "chunk", line: 1, endLine: 3, depth: 0 }], confidence: "low-confidence: chunk outline (unknown language)" }, {});
	assert(unknown.includes("low-confidence"), "unknown language outline flagged");
	const confident = mod.formatOutline({ path: "f.ts", lang: "ts", lines: 10, bytes: 100, symbols: [{ name: "x", kind: "function", line: 1, endLine: 3, depth: 0 }], confidence: "" }, {});
	assert(!confident.includes("low-confidence"), "confident outline has no note");
	// skimFile computes confidence from real content
	writeFileSync(join(TMP, "weird.xyz"), "a\nb\nc\n");
	const f = mod.skimFile(join(TMP, "weird.xyz"));
	assert(typeof f.confidence === "string" && f.confidence.includes("low-confidence"), `unknown lang flagged by skimFile (got ${f.confidence})`);
	const f2 = mod.skimFile(join(TMP, "src", "index.ts"));
	assert(f2.confidence === "", "normal TS file has empty confidence");
}

// ================= Test 15: git change annotation =================
console.log("Test 15: git change annotation — [changed +N/-M] on modified symbols");
{
	const G = join(TMP, "gitdemo");
	mkdirSync(G, { recursive: true });
	const g = (args) => spawnSync("git", args, { cwd: G, encoding: "utf8" });
	g(["init", "-q"]);
	g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
	const f = join(G, "demo.ts");
	writeFileSync(f, [
		"export function alpha(a: string) {",
		"  const x = { ok: true };",
		"  return x;",
		"}",
		"",
		"export function beta() {",
		"  return 2;",
		"}",
	].join("\n") + "\n");
	g(["add", "demo.ts"]);
	g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "initial"]);
	// modify alpha (1 add + 1 delete), leave beta untouched
	writeFileSync(f, [
		"export function alpha(a: string) {",
		"  const x = { ok: false };",
		"  const y = 1;",
		"  return x;",
		"}",
		"",
		"export function beta() {",
		"  return 2;",
		"}",
	].join("\n") + "\n");
	const file = mod.skimFile(f);
	const ch = mod.gitSymbolChanges(file.symbols, f);
	const alpha = file.symbols.find((s) => s.name === "alpha");
	const beta = file.symbols.find((s) => s.name === "beta");
	const aCh = ch.get(alpha.line);
	const bCh = ch.get(beta.line);
	assert(aCh !== undefined && aCh.add === 2 && aCh.del === 1, `alpha changed +2/-1 (got ${JSON.stringify(aCh)})`);
	assert(bCh === undefined, "beta untouched -> no change");
	const out = await mod.runSkim({ path: f }, TMP);
	assert(out.includes("[changed +2/-1]"), "outline renders [changed +2/-1]");
	assert(out.includes("beta") && !out.includes("[changed]"), "only modified symbols flagged");
	// untracked / non-repo file degrades to an empty change map (not a swallowed bug)
	const f3 = mod.skimFile(join(TMP, "src", "index.ts"));
	const ch3 = mod.gitSymbolChanges(f3.symbols, join(TMP, "src", "index.ts"));
	assert(ch3.size === 0, "untracked file -> empty changes (graceful degradation)");
}
// ================= Test 16: scanner fixes =================
console.log("Test 16: scanner fixes — keyword regexes, nested templates, arrow fields");
{
	// regex literal after `return` with an unpaired brace must not corrupt spans
	const src = [
		"function f() {",
		'  return /\\{/.test(s);',
		"}",
		"function g() {",
		"  const x = 1;",
		"}",
	].join("\n").split("\n");
	const syms = mod.outlineFor(src, "ts");
	const f = syms.find((s) => s.name === "f");
	const g = syms.find((s) => s.name === "g");
	assert(f.endLine === 3, `return /\\{/ does not swallow the file (f spans 1-${f.endLine})`);
	assert(g.line === 4 && g.endLine === 6, `g starts after f (got ${g.line}-${g.endLine})`);
	// division still treats / as an operator
	const div = ["function h() {", "  return a / b / c;", "}"].join("\n").split("\n");
	const hs = mod.outlineFor(div, "ts");
	assert(hs[0].endLine === 3, `division does not break spans (got ${hs[0].endLine})`);
	// template literal with nested backticks + object literal in interpolation
	const tpl = [
		"const s = `a ${g({k:1})} b`;",
		"function h() {",
		"  return 1;",
		"}",
	].join("\n").split("\n");
	const tsyms = mod.outlineFor(tpl, "ts");
	const s = tsyms.find((x) => x.name === "s");
	const h = tsyms.find((x) => x.name === "h");
	assert(s.endLine === 1, `template literal const spans only its line (got 1-${s.endLine})`);
	assert(h.line === 2 && h.endLine === 4, `function after template intact (got ${h.line}-${h.endLine})`);
	}

// ================= Test 17: declaration gaps =================
console.log("Test 17: declaration gaps — destructuring, anonymous defaults, arrow fields");
{
	const src = [
		"export const { a, b } = useFoo();",
		"const [c, d] = list;",
		"export const y = 1;",
	].join("\n").split("\n");
	const syms = mod.outlineFor(src, "ts");
	const names = syms.map((s) => `${s.name}:${s.kind}`);
	assert(names.join("|") === "a:const|c:const|y:const", `destructured consts listed (got ${names.join("|")})`);
	// multi-line destructuring takes its first binding as the name
	const multi = [
		"const {",
		"  alpha,",
		"  beta,",
		"} = useFoo();",
	].join("\n").split("\n");
	const ms = mod.outlineFor(multi, "ts");
	assert(ms.length === 1 && ms[0].name === "alpha" && ms[0].kind === "const" && ms[0].endLine === 4, `multi-line destructure named alpha 1-4 (got ${ms[0]?.name} ${ms[0]?.line}-${ms[0]?.endLine})`);
	// anonymous default exports: class extends / arrow
	const anon = [
		"export default class extends Base {}",
		"export default (props) => {",
		"  return <div/>;",
		"};",
	].join("\n").split("\n");
	const as = mod.outlineFor(anon, "ts");
	const def1 = as[0];
	assert(def1.name === "default" && def1.kind === "class", `anon class -> default:class (got ${def1.name}:${def1.kind})`);
	const def2 = as.find((s) => s.kind === "function");
	assert(def2 !== undefined && def2.name === "default" && def2.endLine === 4, `default arrow -> default:function 1-4 (got ${def2?.name} ${def2?.line}-${def2?.endLine})`);
	// class arrow-field methods are recognized with correct spans
	const cls = [
		"class C {",
		"  count = 0;",
		"  onClick = (e) => {",
		"    this.count++;",
		"  };",
		"  static make() {",
		"    return new C();",
		"  }",
		"}",
	].join("\n").split("\n");
	const cs = mod.outlineFor(cls, "ts");
	const onClick = cs.find((x) => x.name === "onClick");
	const make = cs.find((x) => x.name === "make");
	assert(onClick !== undefined && onClick.kind === "method" && onClick.line === 3 && onClick.endLine === 5, `arrow field method 3-5 (got ${onClick?.line}-${onClick?.endLine})`);
	assert(make !== undefined && make.line === 6 && make.endLine === 8, `static method 6-8 (got ${make?.line}-${make?.endLine})`);
}

// ================= Test 18: read line-mode boundaries =================
console.log("Test 18: readSymbol line mode — only same-line block opens");
{
	const src = [
		"const a = 1;",
		"function bar() {",
		"  const b = 2;",
		"  return b;",
		"}",
	].join("\n").split("\n");
	const r1 = mod.readSymbol(src, "ts", 1);
	assert(r1 !== null && r1.line === 1 && r1.endLine === 1, `plain statement line reads one line (got ${r1?.line}-${r1?.endLine})`);
	const r2 = mod.readSymbol(src, "ts", 2);
	assert(r2 !== null && r2.line === 2 && r2.endLine === 5, `brace line reads its block (got ${r2?.line}-${r2?.endLine})`);
	// return-type braces on the header still read the whole body
	const rt = [
		"function f(): { ok: boolean } {",
		"  return { ok: true };",
		"}",
	].join("\n").split("\n");
	const r3 = mod.readSymbol(rt, "ts", 1);
	assert(r3 !== null && r3.endLine === 3, `return-type header reads whole body (got ${r3?.endLine})`);
}


rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
