/**
 * skim — codebase outline for token-efficient reading.
 *
 * Gives the agent a cheap "table of contents" for a file (symbols with line
 * numbers, line spans, and one-line descriptions) so it can read only the
 * relevant ranges instead of whole files. Also supports jumping straight to
 * a symbol's body (`--read`) and a compact directory map.
 *
 * Usage:
 *   skim path/to/file.ts            outline with line numbers + spans
 *   skim path/to/file.ts --read globMatch   read just that function's body
 *   skim path/to/dir                directory map (entry files first)
 *   skim "src/**\/*.ts"             glob across files
 *   skim file.ts --filter glob      only symbols whose name matches
 *   skim file.ts --json             machine-readable outline
 *
 * v1 scope: regex-based extraction (no tree-sitter). Braces are balanced with
 * a string/comment-aware scanner; template-literal `${...}` bodies are treated
 * as string content (acceptable approximation). Files > 1 MB are rejected.
 * Unknown extensions fall back to a blank-line chunk outline.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

export interface SkimSymbol {
	name: string;
	kind: string; // function | method | class | interface | type | const | enum | heading | key | chunk
	line: number; // 1-based
	endLine: number;
	depth: number; // 0 = top level
	desc?: string;
}

export interface SkimFile {
	path: string; // display path (as given, for files)
	lang: string;
	lines: number;
	bytes: number;
	symbols: SkimSymbol[];
}

export interface SkimDirEntry {
	path: string; // path relative to the skimmed directory
	lines: number;
	bytes: number;
	first?: string; // first meaningful line, truncated
	entry: boolean; // looks like an entry point (package.json, index.ts, ...)
	dir: boolean; // bare directory listed without recursion (depth limit reached)
}

export interface SkimDir {
	path: string;
	entries: SkimDirEntry[];
	total: number; // entries shown
	skipped: number; // junk entries skipped
	truncated: boolean; // more entries exist than shown
}

export interface ReadResult {
	text: string;
	line: number; // 1-based first line
	endLine: number; // 1-based last line
	name?: string;
	note?: string;
}

// ============================================================================
// Language patterns
// ============================================================================

interface LangPatterns {
	decl: RegExp; // top-level declaration line
	anonDefault: RegExp; // e.g. `export default function (` without a name
	method: RegExp; // method-like line (inside class spans)
	methodBlacklist: RegExp; // control keywords that must not count as methods
	nameOf: (m: RegExpMatchArray, line: string) => string;
	kindOf: (m: RegExpMatchArray, line: string) => string;
	brace: boolean; // balanced-brace spans
	indented: boolean; // indentation-based spans (python)
}

const METHOD_BLACKLIST =
	/^(if|for|while|switch|catch|return|throw|typeof|instanceof|in|of|new|delete|void|yield|await|else|do|try|finally|case|default|function|class|interface|type|enum|const|let|var|import|export|from|as|async)\b/;

function tsPatterns(): LangPatterns {
	return {
		decl: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?\s+|class\s+|interface\s+|type\s+|enum\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/,
		anonDefault: /^export\s+default\s+(?:async\s+)?function\s*\(/,
		method: /^(?:(?:public|private|protected|static|readonly|async|get|set|\*)\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/,
		methodBlacklist: METHOD_BLACKLIST,
		nameOf: (m) => m[1],
		kindOf: (m, line) => {
			// Strip every leading modifier (export default async ...) so the first
			// remaining keyword decides the kind.
			const kw = line.trim().replace(/^(?:(?:export|default|declare|abstract|async)\s+)+/, "").split(/\s+/)[0];
			if (kw === "function") return "function";
			if (kw === "class") return "class";
			if (kw === "interface") return "interface";
			if (kw === "type") return "type";
			if (kw === "enum") return "enum";
			return "const";
		},
		brace: true,
		indented: false,
	};
}

function mdPatterns(): LangPatterns {
	return {
		decl: /^(#{1,6})\s+(.*)$/,
		anonDefault: /$a/,
		method: /$a/, // never used
		methodBlacklist: /$a/,
		nameOf: (_m, line) => line.trim().replace(/^#{1,6}\s+/, ""),
		kindOf: (m) => `h${m[1].length}`,
		brace: false,
		indented: false,
	};
}

function jsonPatterns(): LangPatterns {
	return {
		decl: /^(\s*)"([^"]+)"\s*:/,
		anonDefault: /$a/,
		method: /$a/,
		methodBlacklist: /$a/,
		nameOf: (_m, line) => {
			const mm = line.match(/"([^"]+)"\s*:/);
			return mm ? mm[1] : line.trim();
		},
		kindOf: (_m, line) => {
			const rest = line.replace(/^\s*"[^"]+"\s*:\s*/, "");
			if (rest.startsWith("{")) return "object";
			if (rest.startsWith("[")) return "array";
			if (rest.startsWith('"')) return "string";
			if (rest.startsWith("true") || rest.startsWith("false")) return "boolean";
			if (rest.startsWith("null")) return "null";
			if (/^-?\d/.test(rest)) return "number";
			return "value";
		},
		brace: false,
		indented: false,
	};
}

function pyPatterns(): LangPatterns {
	return {
		decl: /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/,
		anonDefault: /$a/,
		method: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
		methodBlacklist: /$a/,
		nameOf: (m) => m[1],
		kindOf: (m, line) => (line.trim().startsWith("class") ? "class" : "function"),
		brace: false,
		indented: true,
	};
}

function goPatterns(): LangPatterns {
	return {
		decl: /^(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(|type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b|const\s+([A-Za-z_]\w*)|\bvar\s+([A-Za-z_]\w*))/,
		anonDefault: /$a/,
		method: /^func\s+\([^)]*\)\s+([A-Za-z_]\w*)\s*\(/,
		methodBlacklist: /$a/,
		nameOf: (m) => m[1] ?? m[2] ?? m[3] ?? m[4],
		kindOf: (_m, line) => {
			const t = line.trim();
			if (t.startsWith("func")) return "function";
			if (/type\s+\w+\s+struct/.test(t)) return "class";
			if (/type\s+\w+\s+interface/.test(t)) return "interface";
			return "const";
		},
		brace: true,
		indented: false,
	};
}

function rsPatterns(): LangPatterns {
	return {
		decl: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn\s+([A-Za-z_]\w*)|(?:struct|enum|trait|mod)\s+([A-Za-z_]\w*)|impl(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)|(?:const|static)\s+([A-Za-z_]\w*))/,
		anonDefault: /$a/,
		method: /^(?:\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/,
		methodBlacklist: /$a/,
		nameOf: (m) => m[1] ?? m[2] ?? m[3] ?? m[4],
		kindOf: (m, line) => {
			const t = line.trim();
			if (/^fn\b/.test(t) || /^pub\b.*\bfn\b/.test(t)) return "function";
			if (/^struct\b/.test(t) || /^pub\b.*\bstruct\b/.test(t)) return "class";
			if (/^enum\b/.test(t) || /^pub\b.*\benum\b/.test(t)) return "enum";
			if (/^trait\b/.test(t) || /^pub\b.*\btrait\b/.test(t)) return "interface";
			if (/^impl\b/.test(t)) return "impl";
			return "const";
		},
		brace: true,
		indented: false,
	};
}

function shPatterns(): LangPatterns {
	return {
		decl: /^([A-Za-z_][\w]*)\s*\(\s*\)\s*\{|^##\s+(.+)$/,
		anonDefault: /$a/,
		method: /$a/,
		methodBlacklist: /$a/,
		nameOf: (m) => m[1] ?? m[2],
		kindOf: (_m, line) => (line.trim().startsWith("##") ? "heading" : "function"),
		brace: true,
		indented: false,
	};
}

const EXT_LANGS: Record<string, LangPatterns> = {
	ts: tsPatterns(),
	tsx: tsPatterns(),
	mts: tsPatterns(),
	cts: tsPatterns(),
	js: tsPatterns(),
	jsx: tsPatterns(),
	mjs: tsPatterns(),
	cjs: tsPatterns(),
	md: mdPatterns(),
	markdown: mdPatterns(),
	json: jsonPatterns(),
	jsonc: jsonPatterns(),
	py: pyPatterns(),
	go: goPatterns(),
	rs: rsPatterns(),
	sh: shPatterns(),
	bash: shPatterns(),
	zsh: shPatterns(),
};

function patternsFor(lang: string): LangPatterns | undefined {
	return EXT_LANGS[lang];
}

// ============================================================================
// Scanner: string/comment-aware brace balancing
// Regex-literal skip: `/.../` at expression position, handling escapes and [classes].
function skipRegexLiteral(line: string, j: number): number {
	if (line[j] !== "/") return -1;
	// A `/` preceded by an identifier/quote/close-bracket is division, not a regex.
	let k = j - 1;
	while (k >= 0 && /\s/.test(line[k])) k--;
	if (k >= 0 && /[A-Za-z0-9_$)\]}"'`]/.test(line[k])) return -1;
	let inClass = false;
	for (let i = j + 1; i < line.length; i++) {
		const c = line[i];
		if (c === "\\") { i++; continue; }
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) {
			let e = i + 1;
			while (e < line.length && /[a-z]/i.test(line[e])) e++; // flags
			return e;
		}
	}
	return -1; // unterminated on this line: treat as division, do not skip
}

function scanBalanced(lines: string[], start: number, open: string, close: string, colStart = 0): number {
	let depth = 0;
	let inStr = false;
	let strCh = "";
	let inBlock = false;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		let j = i === start ? colStart : 0;
		while (j < line.length) {
			const c = line[j];
			const n = line[j + 1];
			if (inBlock) {
				if (c === "*" && n === "/") {
					inBlock = false;
					j += 2;
					continue;
				}
				j++;
				continue;
			}
			if (inStr) {
				if (c === "\\") {
					j += 2;
					continue;
				}
				if (c === strCh) inStr = false;
				j++;
				continue;
			}
			if (c === "/" && n === "/") break; // line comment: skip the rest
			if (c === "/" && n === "*") {
				inBlock = true;
				j += 2;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") {
				inStr = true;
				strCh = c;
				j++;
				continue;
			}
			if (c === "/") {
				const reEnd = skipRegexLiteral(line, j);
				if (reEnd !== -1) {
					j = reEnd;
					continue;
				}
			}
			if (c === open) depth++;
			else if (c === close) {
				depth--;
				if (depth === 0) return i;
			}
			j++;
		}
	}
	return -1;
}

/** Find the function-body `{`: the candidate brace whose balanced span is longest.
 * Handles return types like `function f(): { files: string[] } {` — the return
 * type's braces close within a line or two, while the body's brace spans the
 * whole function. Returns the line index of the winning `{`, or null.
 */
function findBodyBrace(lines: string[], start: number, maxScan: number): { line: number; col: number } | null {
	const candidates: { line: number; col: number }[] = [];
	const end = Math.min(lines.length, start + maxScan);
	let inStr = false;
	let strCh = "";
	let inBlock = false;
	for (let i = start; i < end; i++) {
		const line = lines[i];
		let j = 0;
		while (j < line.length) {
			const c = line[j];
			const n = line[j + 1];
			if (inBlock) {
				if (c === "*" && n === "/") {
					inBlock = false;
					j += 2;
					continue;
				}
				j++;
				continue;
			}
			if (inStr) {
				if (c === "\\") {
					j += 2;
					continue;
				}
				if (c === strCh) inStr = false;
				j++;
				continue;
			}
			if (c === "/" && n === "/") break;
			if (c === "/" && n === "*") {
				inBlock = true;
				j += 2;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") {
				inStr = true;
				strCh = c;
				j++;
				continue;
			}
			if (c === "/") {
				const reEnd = skipRegexLiteral(line, j);
				if (reEnd !== -1) {
					j = reEnd;
					continue;
				}
			}
			if (c === "{") candidates.push({ line: i, col: j });
			j++;
		}
	}
	if (candidates.length === 0) return null;
	// Pick the first candidate whose balanced span ends with a line that ends in
	// `}` — a real body. Return-type braces (`): { files: string[] } {`) close
	// mid-line with more code after them, so they lose. Fall back to the first
	// candidate (e.g. `const x = { a: 1 };` ends in `;`).
	for (const c of candidates) {
		const close = scanBalanced(lines, c.line, "{", "}", c.col);
		if (close === -1) return c;
		if (lines[close].trimEnd().endsWith("}")) return c;
	}
	return candidates[0];
}

/** Find the line index of a top-level line ending with `;` (or `:` for python), capped. */
/** First unquoted `{` on the declaration line (or within a few lines). */
function findInlineBrace(lines: string[], start: number, maxScan: number): { line: number; col: number } | null {
	const end = Math.min(lines.length, start + maxScan);
	let inStr = false;
	let strCh = "";
	let inBlock = false;
	for (let i = start; i < end; i++) {
		const line = lines[i];
		let j = 0;
		while (j < line.length) {
			const c = line[j];
			const n = line[j + 1];
			if (inBlock) {
				if (c === "*" && n === "/") {
					inBlock = false;
					j += 2;
					continue;
				}
				j++;
				continue;
			}
			if (inStr) {
				if (c === "\\") {
					j += 2;
					continue;
				}
				if (c === strCh) inStr = false;
				j++;
				continue;
			}
			if (c === "/" && n === "/") break;
			if (c === "/" && n === "*") {
				inBlock = true;
				j += 2;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") {
				inStr = true;
				strCh = c;
				j++;
				continue;
			}
			if (c === "{") return { line: i, col: j };
			j++;
		}
	}
	return null;
}


function findStatementEnd(lines: string[], start: number, maxScan: number, terminator: string): number {
	const end = Math.min(lines.length, start + maxScan);
	for (let i = start; i < end; i++) {
		const t = lines[i].replace(/\/\/.*$/, "").trimEnd();
		if (t.endsWith(terminator)) return i;
	}
	return -1;
}

// ============================================================================
// Description extraction
// ============================================================================

function inlineComment(line: string): string | undefined {
	const m = line.match(/(?:\/\/|\s#)\s*(.+?)\s*$/);
	if (m && !line.trim().startsWith("//") && !line.trim().startsWith("#")) return m[1];
	return undefined;
}

function docBlockAbove(lines: string[], lineIdx: number): string | undefined {
	// Collect contiguous comment lines directly above the symbol, newest first.
	// Decorative separator lines (// ====, // ----) are skipped.
	const collected: string[] = [];
	let i = lineIdx - 1;
	while (i >= 0) {
		const t = lines[i].trim();
		if (t === "") {
			// allow exactly one blank line between docblock and symbol
			if (collected.length === 0) {
				i--;
				continue;
			}
			break;
		}
	if (t.startsWith("//") || t.startsWith("#")) {
		const text = t.replace(/^\/\/\s*/, "").replace(/^#\s*/, "");
		if (/^[=\-*~#\s]+$/.test(text)) {
			i--;
			continue;
		}
		collected.unshift(text);
		i--;
		continue;
	}
		if (t.startsWith("/*") || t.startsWith("/**")) {
			const inner = t.replace(/^\/\*+\s*/, "").replace(/\s*\*\/\s*$/, "");
			collected.unshift(inner);
			i--;
			continue;
		}
		if (t.startsWith("*")) {
			const inner = t.replace(/^\*\s*/, "");
			// A bare `*/` (or `*`) line must not leak a "/" description.
			if (!/^[/*]*$/.test(inner)) collected.unshift(inner);
			i--;
			continue;
		}
		break;
	}
/** Decorative banner lines ("// ==== ... ====") must not become descriptions. */
function isDecorative(s: string): boolean {
	const t = s.trim();
	if (t.length < 2) return false;
	const edge = /[=\-*~#]/;
	return edge.test(t[0]) && edge.test(t[t.length - 1]);
}

	// The first non-empty, non-decorative collected line is the summary (top of the block).
	for (const line of collected) {
		if (line && !isDecorative(line)) return line;
	}
	return undefined;
}

// ============================================================================
// Outline extraction
// ============================================================================

function indentOf(line: string): number {
	const m = line.match(/^\s*/);
	return m ? m[0].length : 0;
}

function extractTsLike(lines: string[], patterns: LangPatterns): SkimSymbol[] {
	const symbols: SkimSymbol[] = [];
	const classSpans: { start: number; end: number; indent: number }[] = [];
	// Pass 1: root declarations.
	let minDeclIndent = Infinity;
	const declLines: { idx: number; indent: number }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const indent = indentOf(line);
		const body = line.trim();
		if (!body) continue;
		if (patterns.decl.test(body) || patterns.anonDefault.test(body)) {
			declLines.push({ idx: i, indent });
			if (indent < minDeclIndent) minDeclIndent = indent;
		}
	}
	const rootIndent = declLines.length > 0 ? minDeclIndent : 0;

	for (const { idx: i, indent } of declLines) {
		if (indent !== rootIndent) continue; // nested declarations handled below (methods)
		const line = lines[i];
		const body = line.trim();
		if (patterns.anonDefault.test(body)) {
			const endLine = spanFor(lines, i, patterns, 10);
			symbols.push({
				name: "default",
				kind: "function",
				line: i + 1,
				endLine: endLine + 1,
				depth: 0,
				desc: descFor(lines, i),
			});
			continue;
		}
		const m = body.match(patterns.decl);
		if (!m) continue;
		const name = patterns.nameOf(m, body);
		if (!name) continue;
		const kind = patterns.kindOf(m, body);
		const inlineFirst = kind === "const" || kind === "type" || kind === "interface" || kind === "enum";
		const endLine = spanFor(lines, i, patterns, 10, inlineFirst);
		const sym: SkimSymbol = {
			name,
			kind,
			line: i + 1,
			endLine: endLine + 1,
			depth: 0,
			desc: descFor(lines, i),
		};
		symbols.push(sym);
		if (kind === "class" && patterns.brace) {
			const open = findBodyBrace(lines, i, 10);
			if (open !== null) {
				const close = scanBalanced(lines, open.line, "{", "}", open.col);
				classSpans.push({ start: open.line, end: close === -1 ? lines.length - 1 : close, indent });
			}
		}
	}

	// Pass 2: methods inside class spans.
	for (const span of classSpans) {
		for (let i = span.start + 1; i <= span.end; i++) {
			const line = lines[i];
			const indent = indentOf(line);
			if (indent <= span.indent) continue;
			const body = line.trim();
			if (!body) continue;
			const m = body.match(patterns.method);
			if (!m || patterns.methodBlacklist.test(m[1])) continue;
			const name = patterns.nameOf(m, body);
			if (!name) continue;
			const endLine = spanFor(lines, i, patterns, 10);
			symbols.push({
				name,
				kind: "method",
				line: i + 1,
				endLine: endLine + 1,
				depth: 1,
				desc: descFor(lines, i),
			});
			i = endLine; // skip past the method body
		}
	}

	symbols.sort((a, b) => a.line - b.line || a.depth - b.depth);
	return symbols;
}

/** Span end (0-based line index) for a symbol starting at `start`. */
function spanFor(lines: string[], start: number, patterns: LangPatterns, maxScan: number, inlineFirst = false): number {
	if (patterns.indented) {
		// Python-style: run until a line with indent <= start indent (non-blank, non-comment).
		const base = indentOf(lines[start]);
		for (let i = start + 1; i < lines.length; i++) {
			const t = lines[i].trim();
			if (t === "" || t.startsWith("#")) continue;
			if (indentOf(lines[i]) <= base) return i - 1;
		}
		return lines.length - 1;
	}
	if (patterns.brace) {
		const open = inlineFirst
			? findInlineBrace(lines, start, maxScan)
			: findBodyBrace(lines, start, maxScan);
		if (open !== null) {
			const close = scanBalanced(lines, open.line, "{", "}", open.col);
			return close === -1 ? lines.length - 1 : close;
		}
	}
	// No brace: statement ends at `;` (ts/go/rs) — json handled elsewhere.
	const end = findStatementEnd(lines, start, 40, ";");
	return end === -1 ? start : end;
}

function descFor(lines: string[], idx: number): string | undefined {
	const inline = inlineComment(lines[idx]);
	if (inline) return inline;
	return docBlockAbove(lines, idx);
}

/** Markdown: headings outside code fences and HTML comments. */
function extractMarkdown(lines: string[]): SkimSymbol[] {
	const symbols: SkimSymbol[] = [];
	let inFence = false;
	let inComment = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const t = line.trim();
		if (inComment) {
			if (t.includes("-->")) inComment = false;
			continue;
		}
		if (inFence) {
			if (/^(`{3,}|~{3,})/.test(t)) inFence = false;
			continue;
		}
		if (t.startsWith("<!--")) {
			if (!t.includes("-->")) inComment = true;
			continue;
		}
		if (/^(`{3,}|~{3,})/.test(t)) {
			inFence = true;
			continue;
		}
		const m = t.match(/^(#{1,6})\s+(.*)$/);
		if (m) {
			const level = m[1].length;
			symbols.push({
				name: m[2],
				kind: `h${level}`,
				line: i + 1,
				endLine: i + 1,
				depth: level - 1,
			});
		}
	}
	// Fill spans: heading runs until the next heading of same or higher level.
	for (let k = 0; k < symbols.length; k++) {
		const s = symbols[k];
		const level = Number(s.kind.slice(1));
		let end = s.line; // 1-based
		for (let j = k + 1; j < symbols.length; j++) {
			const nextLevel = Number(symbols[j].kind.slice(1));
			if (nextLevel <= level) {
				end = symbols[j].line - 1;
				break;
			}
			end = symbols[j].line - 1;
		}
		if (end < s.line) end = s.line;
		s.endLine = end;
	}
	return symbols;
}

/** JSON: top-level keys with type + span, string-aware, tolerant of parse errors. */
function extractJson(lines: string[]): SkimSymbol[] {
	const symbols: SkimSymbol[] = [];
	let depth = 0;
	let inStr = false;
	let strCh = "";
	let inBlock = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let j = 0;
		let keyAt: number | null = null;
		let colonAt = -1;
		while (j < line.length) {
			const c = line[j];
			const n = line[j + 1];
			if (inBlock) {
				if (c === "*" && n === "/") {
					inBlock = false;
					j += 2;
					continue;
				}
				j++;
				continue;
			}
			if (inStr) {
				if (c === "\\") {
					j += 2;
					continue;
				}
				if (c === strCh) {
					inStr = false;
					if (strCh === '"' && keyAt === null) keyAt = j;
				}
				j++;
				continue;
			}
			if (c === "/" && n === "/") break;
			if (c === "/" && n === "*") {
				inBlock = true;
				j += 2;
				continue;
			}
			if (c === '"') {
				inStr = true;
				strCh = c;
				j++;
				continue;
			}
			if (c === ":" && keyAt !== null && depth === 1 && colonAt === -1) colonAt = j;
			if (c === "{" || c === "[") depth++;
			else if (c === "}" || c === "]") depth--;
			j++;
		}
		// A top-level key is one whose `:` appears while the container depth is 1.
		if (colonAt !== -1) {
			const nameM = line.slice(0, keyAt! + 1).match(/"([^"]+)"\s*$/);
			const name = nameM ? nameM[1] : "?";
			const value = line.slice(colonAt + 1).trim();
			let kind = "value";
			let endLine = i;
			if (value.startsWith("{")) {
				kind = "object";
				const close = scanBalanced(lines, i, "{", "}", line.indexOf("{"));
				endLine = close === -1 ? i : close;
			} else if (value.startsWith("[")) {
				kind = "array";
				const close = scanBalanced(lines, i, "[", "]", line.indexOf("["));
				endLine = close === -1 ? i : close;
			} else if (value.startsWith('"')) kind = "string";
			else if (/^-?\d/.test(value)) kind = "number";
			else if (value.startsWith("true") || value.startsWith("false")) kind = "boolean";
			else if (value.startsWith("null")) kind = "null";
			symbols.push({ name, kind, line: i + 1, endLine: endLine + 1, depth: 0 });
		}
	}
	return symbols;
}

/** Generic fallback: runs of non-blank lines. */
function extractChunks(lines: string[]): SkimSymbol[] {
	const symbols: SkimSymbol[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i].trim() === "") {
			i++;
			continue;
		}
		const start = i;
		let end = i;
		while (i < lines.length && lines[i].trim() !== "") {
			end = i;
			i++;
		}
		const first = lines[start].trim().slice(0, 60);
		symbols.push({
			name: first || "(blank)",
			kind: "chunk",
			line: start + 1,
			endLine: end + 1,
			depth: 0,
		});
	}
	return symbols;
}

export function outlineFor(lines: string[], lang: string): SkimSymbol[] {
	if (lang === "md") return extractMarkdown(lines);
	if (lang === "json") return extractJson(lines);
	const patterns = patternsFor(lang);
	if (!patterns) return extractChunks(lines);
	const syms = extractTsLike(lines, patterns);
	return syms.length > 0 ? syms : extractChunks(lines);
}

// ============================================================================
// File skim
// ============================================================================

export function detectLang(file: string): string {
	const ext = extname(file).replace(/^\./, "").toLowerCase();
	return ext || "unknown";
}

const MAX_FILE_BYTES = 1024 * 1024;

export function isBinary(buf: Buffer): boolean {
	return buf.subarray(0, 8192).includes(0);
}

export function skimFile(file: string): SkimFile {
	const st = statSync(file);
	if (st.size > MAX_FILE_BYTES) {
		throw new Error(`file too large for skim (${st.size} bytes > 1 MB): use read instead`);
	}
	const buf = readFileSync(file);
	if (isBinary(buf)) {
		throw new Error(`binary file: skim only handles text`);
	}
	const text = buf.toString("utf8").replace(/\r\n/g, "\n");
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const lang = detectLang(file);
	const symbols = outlineFor(lines, lang);
	return { path: file, lang, lines: lines.length, bytes: st.size, symbols };
}

// ============================================================================
// Directory map
// ============================================================================

const JUNK_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"__pycache__",
	".venv",
	"venv",
	".git",
	".svn",
	".hg",
	".next",
	".turbo",
]);
const JUNK_FILES = /\.(lock|min\.js|map|pyc|class|o|a|so|dll|dylib|exe|png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|eot|zip|gz|tar|tgz|7z|rar|mp4|mp3|wav|mov|db|sqlite3?)$/i;
const ENTRY_NAMES = new Set([
	"package.json",
	"tsconfig.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"Makefile",
	"Dockerfile",
	"docker-compose.yml",
	"compose.yaml",
	"README.md",
	"readme.md",
]);
const ENTRY_RE = /^(index|main|cli|app|server)\.(ts|tsx|js|jsx|mjs|py|go|rs|sh)$/;

/** First meaningful line of a text file; md headings count as content. */
function firstOf(text: string, isMarkdown: boolean): string | undefined {
	for (const raw of text.split("\n")) {
		const t = raw.trim();
		if (!t) continue;
		if (t.startsWith("#!") || (t.startsWith("# ") && !isMarkdown) || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("<!--") || t.startsWith(";") || t.startsWith("'''") || t.startsWith('"""')) continue;
		return t.slice(0, 60);
	}
	return undefined;
}

function firstMeaningfulLine(file: string): string | undefined {
	try {
		const buf = readFileSync(file);
		if (isBinary(buf)) return undefined;
		return firstOf(buf.toString("utf8"), /\.(md|markdown)$/i.test(file));
	} catch {
		return undefined;
	}
}

function walkDir(
	root: string,
	dir: string,
	depth: number,
	maxDepth: number,
	out: SkimDirEntry[],
	state: { skipped: number },
): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	names.sort((a, b) => a.localeCompare(b));
	for (const name of names) {
		const full = join(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		const rel = relative(root, full);
		if (st.isDirectory()) {
			if (JUNK_DIRS.has(name) || name.startsWith(".")) {
				state.skipped++;
				continue;
			}
			if (depth < maxDepth) {
				walkDir(root, full, depth + 1, maxDepth, out, state);
			} else {
				// At the depth limit the directory is listed as a bare entry
				// (visible but not expanded).
				out.push({ path: rel, lines: 0, bytes: 0, first: undefined, entry: false, dir: true });
			}
			continue;
		}
		if (name.startsWith(".") || JUNK_FILES.test(name)) {
			state.skipped++;
			continue;
		}
		const entry: SkimDirEntry = {
			path: rel,
			lines: 0,
			bytes: st.size,
			first: undefined,
			entry: ENTRY_NAMES.has(name) || ENTRY_RE.test(name) || /^README\./i.test(name),
			dir: false,
		};
		// One read serves both the line count and the first meaningful line.
		try {
			const buf = readFileSync(full);
			if (buf.length > 0) {
				const text = buf.toString("utf8");
				entry.lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
				if (!isBinary(buf)) entry.first = firstOf(text, /\.(md|markdown)$/i.test(name));
			}
		} catch {
			// unreadable file: leave lines=0
		}
		out.push(entry);
	}
}
export function skimDir(root: string, depth = 1, limit = 150): SkimDir {
	const entries: SkimDirEntry[] = [];
	const state = { skipped: 0 };
	walkDir(root, root, 1, Math.max(1, Math.min(4, depth)), entries, state);
	const truncated = entries.length > limit;
	const shown = truncated ? entries.slice(0, limit) : entries;
	// Sort: entry files first, then files, then nested paths, then bare dirs, alphabetical.
	shown.sort((a, b) => {
		const nestedA = a.path.includes(sep);
		const nestedB = b.path.includes(sep);
		if (a.entry !== b.entry) return a.entry ? -1 : 1;
		if (a.dir !== b.dir) return a.dir ? 1 : -1; // bare dirs last
		if (nestedA !== nestedB) return nestedA ? 1 : -1; // files before nested dirs
		return a.path.localeCompare(b.path);
	});
	return { path: root, entries: shown, total: shown.length, skipped: state.skipped, truncated };
}

// ============================================================================
// Symbol body extraction (--read)
// ============================================================================

function findSymbol(symbols: SkimSymbol[], target: string): SkimSymbol | undefined {
	const exact = symbols.find((s) => s.name === target);
	if (exact) return exact;
	const pref = symbols.find((s) => s.name.startsWith(target));
	if (pref) return pref;
	return symbols.find((s) => s.name.includes(target));
}

export function readSymbol(lines: string[], lang: string, target: string | number): ReadResult | null {
	const targetStr = String(target).trim();
	const num = typeof target === "number" ? target : /^\d+$/.test(targetStr) ? parseInt(targetStr, 10) : NaN;
	if (!Number.isNaN(num)) {
		const idx = Math.max(0, num - 1);
		if (idx >= lines.length) return null;
		// Line-number mode: if the line opens a block, read to its close; else one line.
		const patterns = patternsFor(lang);
		let end = idx;
		if (patterns && patterns.brace) {
			const open = findBodyBrace(lines, idx, 10);
			if (open !== null) {
				const close = scanBalanced(lines, open.line, "{", "}", open.col);
				if (close !== -1) end = close;
			}
		} else if (lang === "md") {
			// treat as heading-based section
			const t = lines[idx].trim();
			const m = t.match(/^(#{1,6})\s+/);
			if (m) {
				const level = m[1].length;
				let e = idx;
				for (let i = idx + 1; i < lines.length; i++) {
					const hm = lines[i].trim().match(/^(#{1,6})\s+/);
					if (hm && hm[1].length <= level) break;
					e = i;
				}
				end = e;
			}
		} else if (lang === "json") {
		// Find the value's opening bracket on this line ({ or [) and balance it.
		let openB: number | null = null;
		for (let i = idx; i < Math.min(lines.length, idx + 1); i++) {
			const cb = lines[i].indexOf("{");
			const sb = lines[i].indexOf("[");
			if (cb !== -1 && (sb === -1 || cb < sb)) openB = cb;
			else if (sb !== -1) openB = sb;
		}
		if (openB !== null) {
			const ch = lines[idx][openB];
			const close = scanBalanced(lines, idx, ch, ch === "{" ? "}" : "]");
			if (close !== -1) end = close;
		}
	} else if (patterns && patterns.indented) {
			const base = indentOf(lines[idx]);
			for (let i = idx + 1; i < lines.length; i++) {
				const t = lines[i].trim();
				if (t === "" || t.startsWith("#")) continue;
				if (indentOf(lines[i]) <= base) break;
				end = i;
			}
		}
		const text = lines.slice(idx, end + 1).join("\n");
		return { text, line: idx + 1, endLine: end + 1, note: "line" };
	}

	const symbols = outlineFor(lines, lang);
	const sym = findSymbol(symbols, targetStr);
	if (!sym) return null;
	const text = lines.slice(sym.line - 1, sym.endLine).join("\n");
	return { text, line: sym.line, endLine: sym.endLine, name: sym.name };
}

// ============================================================================
// Formatting
// ============================================================================

export function estimateTokens(bytes: number): number {
	return Math.max(1, Math.round(bytes / 4));
}

export function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "...";
}

const KIND_LABEL: Record<string, string> = {
	function: "function",
	method: "method",
	class: "class",
	interface: "interface",
	type: "type",
	const: "const",
	enum: "enum",
	heading: "heading",
	chunk: "chunk",
	impl: "impl",
};

export function formatOutline(file: SkimFile, opts: { full?: boolean; limit?: number; filter?: string }): string {
	const full = opts.full ?? false;
	const limit = opts.limit ?? 150;
	let filter: RegExp | null = null;
	if (opts.filter) {
		try {
			filter = new RegExp(opts.filter);
		} catch {
			throw new Error(`invalid filter regex: ${opts.filter}`);
		}
	}
	const nameMax = full ? 200 : 80;
	const descMax = full ? 160 : 60;

	let syms = file.symbols;
	if (filter) syms = syms.filter((s) => filter.test(s.name));
	const truncated = syms.length > limit;
	const shown = truncated ? syms.slice(0, limit) : syms;

	const header = `${basename(file.path)} (${file.lines} lines | ${fmtBytes(file.bytes)} | ~${estimateTokens(file.bytes)} tok | ${shown.length} symbol${shown.length === 1 ? "" : "s"})`;
	const rows = shown.map((s) => {
		const label = KIND_LABEL[s.kind] ?? s.kind;
		const prefix = s.depth === 0 ? "|- " : `${"  ".repeat(s.depth)}|- `;
		const span = s.endLine > s.line ? ` (${s.endLine - s.line + 1} lines)` : "";
		let row = `${prefix}${label} ${truncate(s.name, nameMax)} @${s.line}${span}`;
		if (s.desc) row += ` - ${truncate(s.desc, descMax)}`;
		return row;
	});
	const tail = truncated ? `\n... +${syms.length - limit} more symbols (use --filter or --full)` : "";
	return [header, ...rows].join("\n") + tail;
}

export function formatRead(file: SkimFile, result: ReadResult): string {
	const label = result.name ? `- ${result.name}` : "";
	const note = result.note ? ` - ${result.note}` : "";
	return `${basename(file.path)}:${result.line}-${result.endLine}${label}${note}\n${result.text}`;
}

export function formatDir(dir: SkimDir): string {
	const header = `${basename(dir.path) || dir.path} (${dir.total} entries${dir.skipped > 0 ? ` | ${dir.skipped} skipped` : ""}${dir.truncated ? " | truncated" : ""})`;
	const rows = dir.entries.map((e) => {
		const mark = e.entry ? "* " : "  ";
		const name = e.dir ? `${e.path}/` : e.path;
		const size = e.dir ? "dir" : fmtBytes(e.bytes);
		const lines = e.lines > 0 ? ` | ${e.lines} lines` : "";
		const first = e.first ? ` - ${e.first}` : "";
		return `${mark}${name} (${size}${lines})${first}`;
	});
	return [header, ...rows].join("\n");
}

// ============================================================================
// Cache (per path, invalidated by mtime+size)
// ============================================================================

interface CacheEntry {
	mtimeMs: number;
	size: number;
	data: SkimFile | SkimDir;
}

const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 64;

function cached<T extends SkimFile | SkimDir>(key: string, load: () => T): T {
	const st = statSync(key);
	const hit = cache.get(key);
	if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data as T;
	const data = load();
	cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, data });
	if (cache.size > CACHE_MAX) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	return data;
}

// ============================================================================
// Glob expansion
// ============================================================================

function segToRe(seg: string): RegExp {
	let re = "";
	for (let i = 0; i < seg.length; i++) {
		const c = seg[i];
		if (c === "*") {
			if (seg[i + 1] === "*") {
				re += ".*";
				i++;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

/** Expand a glob (supporting *, **, ?) into matching file paths. Cap at 200. */
export function expandGlob(pattern: string, cwd: string): string[] {
	const abs = resolve(cwd, pattern);
	const root = parse(abs).root; // drive root on Windows ("C:\\"), "/" on POSIX
	const segs = abs.slice(root.length).split(sep).filter((s) => s !== "");
	const out: string[] = [];
	const walk = (dir: string, idx: number) => {
		if (out.length >= 200) return;
		if (idx >= segs.length) {
			try {
				if (!statSync(dir).isDirectory()) out.push(dir);
			} catch {
				// unreadable path: skip
			}
			return;
		}
		const seg = segs[idx];
		if (seg === "**") {
			walk(dir, idx + 1); // ** also matches zero directories
			let names: string[] = [];
			try {
				names = readdirSync(dir);
			} catch {
				return;
			}
			for (const n of names) {
				if (n.startsWith(".")) continue;
				const full = join(dir, n);
				let st;
				try {
					st = statSync(full);
				} catch {
					continue;
				}
				if (st.isDirectory()) walk(full, idx);
				else if (idx + 1 >= segs.length && out.length < 200) out.push(full);
			}
			return;
		}
		const re = segToRe(seg);
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const n of names) {
			if (out.length >= 200) return;
			if (!re.test(n)) continue;
			const full = join(dir, n);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(full, idx + 1);
			else if (idx + 1 >= segs.length) out.push(full);
		}
	};
	walk(root || ".", 0);
	return out;
}

// ============================================================================
// Tool + command
// ============================================================================

interface SkimParams {
	path: string;
	read?: string;
	filter?: string;
	full?: boolean;
	json?: boolean;
	depth?: number;
	limit?: number;
}

function resolveTarget(pathOrGlob: string, cwd: string): { kind: "file" | "dir"; path: string } {
	const abs = resolve(cwd, pathOrGlob);
	let st;
	try {
		st = statSync(abs);
	} catch {
		throw new Error(`path not found: ${pathOrGlob}`);
	}
	return st.isDirectory() ? { kind: "dir", path: abs } : { kind: "file", path: abs };
}

export async function runSkim(params: SkimParams, cwd: string): Promise<string> {
	const p = params.path;
	const globChars = /[*?]/.test(p);
	if (globChars) {
		const matches = expandGlob(p, cwd);
		if (matches.length === 0) return `no files match: ${p}`;
		if (matches.length > 20) {
			return `too many matches (${matches.length}): narrow the glob`;
		}
		const parts: string[] = [];
		for (const m of matches) {
			const st = statSync(m);
			if (st.isDirectory()) parts.push(formatDir(cached(m, () => skimDir(m, params.depth ?? 1, params.limit ?? 150))));
			else parts.push(formatOutline(cached(m, () => skimFile(m)), { full: params.full, limit: params.limit, filter: params.filter }));
		}
		return parts.join("\n\n");
	}

	const { kind, path } = resolveTarget(p, cwd);
	if (kind === "dir") {
		// Directory maps are not cached: file-content edits do not bump the
		// directory mtime, so a cached map could go stale.
		const dir = skimDir(path, params.depth ?? 1, params.limit ?? 150);
		return params.json ? JSON.stringify(dir) : formatDir(dir);
	}

	const file = cached(path, () => skimFile(path));
	if (params.read) {
		const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
		const lines = text.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		const result = readSymbol(lines, file.lang, params.read);
		if (!result) return `symbol not found: ${params.read} (file has ${file.symbols.length} symbols - run skim without --read for the outline)`;
		return formatRead(file, result);
	}
	if (params.json) return JSON.stringify(file);
	return formatOutline(file, { full: params.full, limit: params.limit, filter: params.filter });
}

export default async function skimExtension(pi: ExtensionAPI): Promise<void> {
	let schema: object | undefined;
	try {
		const { Type } = await import("typebox");
		schema = Type.Object({
			path: Type.String({ description: "File path, directory, or glob to skim" }),
			read: Type.Optional(Type.String({ description: "Symbol name or line number to read directly (e.g. 'globMatch' or '428')" })),
			filter: Type.Optional(Type.String({ description: "Only show symbols whose name matches this regex" })),
			full: Type.Optional(Type.Boolean({ description: "Do not truncate names and descriptions" })),
			json: Type.Optional(Type.Boolean({ description: "Return machine-readable JSON instead of text" })),
			depth: Type.Optional(Type.Number({ description: "Directory recursion depth (default 1, max 4)" })),
			limit: Type.Optional(Type.Number({ description: "Max outline rows (default 150)" })),
		});
	} catch {
		// typebox unavailable (plain-Node tests) — parameters left empty; pi always has it
	}

	pi.registerTool({
		name: "skim",
		label: "Skim",
		description:
			"Get a compact outline of a file (symbols with line numbers, line spans, and one-line descriptions), read a symbol's body directly (--read), or map a directory. Use before reading whole files to save context. Equivalent of a table of contents for code.",
		parameters: (schema ?? {}) as never,
		async execute(_toolCallId, params: SkimParams, _signal, _onUpdate, ctx) {
			try {
				const text = await runSkim(params, ctx.cwd);
				return { content: [{ type: "text", text }], details: {} };
			} catch (err) {
				return {
					content: [{ type: "text", text: `skim: ${err instanceof Error ? err.message : String(err)}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("skim", {
		description: "Show a file outline / directory map / symbol body (skim <path> [--read <sym>] [--full] [--filter <re>])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			if (argv.length === 0) {
				ctx.ui.notify("Usage: /skim <path> [--read <symbol|line>] [--full] [--filter <regex>]", "info");
				return;
			}
			let path: string | undefined;
			const params: SkimParams = { path: "" };
			for (let i = 0; i < argv.length; i++) {
				const a = argv[i];
				if (a === "--read") params.read = argv[++i];
				else if (a === "--full") params.full = true;
				else if (a === "--json") params.json = true;
				else if (a === "--filter") params.filter = argv[++i];
				else if (a === "--depth") { const v = Number(argv[++i]); if (!Number.isNaN(v)) params.depth = v; }
				else if (a === "--limit") { const v = Number(argv[++i]); if (!Number.isNaN(v)) params.limit = v; }
				else if (!path) path = a;
			}
			if (!path) {
				ctx.ui.notify("Usage: /skim <path> [--read <symbol|line>] [--full] [--filter <regex>]", "info");
				return;
			}
			params.path = path;
			try {
				const text = await runSkim(params, ctx.cwd);
				ctx.ui.notify(text, "info");
			} catch (err) {
				ctx.ui.notify(`skim: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
