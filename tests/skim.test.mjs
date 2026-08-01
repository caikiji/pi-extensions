// Regression test for extensions/skim.ts.
// Loads the real extension with a fake pi API — no network, no pi session, no npm deps.
// Requires Node >= 22.18 (native TypeScript type stripping) — just run:  node tests/skim.test.mjs

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
