/**
 * rules.ts — RULES.md ground-truth rules manager
 *
 * RULES.md is a user-maintained, stable rules file (independent of the
 * AGENTS.md/CLAUDE.md ecosystem). It changes ONLY when the user edits it;
 * agents must follow it and ask the user when it conflicts with reality.
 *
 * Usage:
 *   /rules          Show loaded rules, imports, and diagnostics (same as /rules list)
 *   /rules list     Same as above
 *   /rules show     Preview the EXPANDED rules in a scrollable window
 *                   (floating overlay by default, /rules show full = full screen, Esc closes)
 *   /rules init     Create a RULES.md template in the current directory
 *                   (--force overwrites an existing file, -g writes to the global agent dir)
 *   /rules reload   Re-read RULES.md files and rebuild the system prompt
 * RULES.md syntax (loaded from ~/.pi/agent/RULES.md and <cwd>/RULES.md):
 *   <!-- comment -->                     comment; stripped at load, never reaches the prompt
 *   @import docs/x.md                    import a whole file (relative to THIS file's directory)
 *   @import docs/x.md#section            import one heading section (heading line included)
 *   @import docs/*.md                    glob import: * one level, ** recursive, ? one char
 *   @rules max_depth 5                   set limits: max_depth / max_glob_files / max_total_bytes
 *   Imported files may import further (cycles detected, files deduped, limits via @rules).
 *
 * The expanded result is appended to the system prompt on every turn via the
 * `before_agent_start` event. Content is byte-stable across turns, so provider
 * prompt caches keep hitting unless a rules file actually changes.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui"; // type-only: erased at runtime

// ============================================================================
// Limits & template
// ============================================================================

const DEFAULT_LIMITS = { maxDepth: 5, maxGlobFiles: 50, maxTotalBytes: 50 * 1024 };


interface RulesConfig {
  maxDepth: number; // import nesting levels allowed from RULES.md
  maxGlobFiles: number; // glob matches above this trigger a warning
  maxTotalBytes: number; // expanded size above this triggers a warning
}

interface AppliedSetting {
  source: string;
  key: string;
  value: string;
}

function defaultConfig(): RulesConfig {
  return { ...DEFAULT_LIMITS };
}
const TEMPLATE = `<!-- ============================================================
  RULES.md — user-maintained ground truth for AI agents
  RULES.md —— 用户维护的恒真规则文件

  This file is authoritative and stable: it changes ONLY when you
  edit it. Agents must follow it; if a rule conflicts with the
  code they observe, they should ask you to clarify — never modify
  this file themselves.
  本文件权威且稳定：只在你主动修改时变更。Agent 必须遵守；
  若规则与代码现实冲突，应向用户求证，而不是自行修改本文件。

  Syntax / 语法（示例都在注释内，加载时剥离，不进提示词）：
    &lt;!-- comment --&gt;                HTML comment; stripped at load
                                          注释；加载时剥离，不进提示词
    @import docs/x.md                     import a whole file (path relative to THIS file's directory)
                                          导入整文件（路径相对本文件所在目录）
    @import docs/x.md#section             import one heading section (heading line included)
                                          只导入该标题的 section（含标题行）
    @import docs/*.md                     glob import: * = one level, ** = recursive, ? = one char
                                          glob 导入：* 单层、** 递归、? 单字符
    \\@import literal                      escaped: shown literally, not expanded
                                          转义，原样显示、不展开
    @rules max_depth 5                    set limits (affects rest of this file + its imports):
                                          设置参数（影响本文件其余部分及其导入）
    @rules max_glob_files 50              max_depth / max_glob_files / max_total_bytes (b/kb/mb)
    @rules max_total_bytes 50kb           defaults: depth 5 · glob 50 files · 50 KB
                                          默认值：深度 5 · glob 50 个文件 · 总量 50 KB
    Imported files may import further (cycles detected, files deduped)
    被导入文件可继续导入（自动防环、按路径去重）
============================================================ -->

<!-- ===== Decisions & rationale (why, not how) ===== -->
<!-- ===== 决策与理由（为什么这么做，而不是怎么做） ===== -->

<!-- Example / 示例：
- Package manager is pnpm: workspace support is more reliable than npm
- 包管理用 pnpm：workspace 支持比 npm 更稳
-->

<!-- ===== Constraints & traps (not visible in the code) ===== -->
<!-- ===== 约束与陷阱（代码里看不出来的红线） ===== -->

<!-- Example / 示例：
- dist/ is generated output; never edit it by hand
- dist/ 是构建产物，永远不要手改
-->

<!-- ===== Intent (layout changes, intent does not) ===== -->
<!-- ===== 意图（布局会变，意图不会） ===== -->

<!-- Example / 示例：
- This repo's end goal is to be split into independent npm packages
- 本仓库的最终目标是拆成独立 npm 包
-->

<!-- ===== Imports (stable pointers to curated documents) ===== -->
<!-- ===== 导入（指向你选定维护的文档的稳定指针） ===== -->

<!-- Example / 示例：
@import docs/conventions.md
@import docs/architecture.md#data-flow
@import docs/patterns/*.md
-->
`;

// ============================================================================
// Types
// ============================================================================

interface Diagnostic {
  level: "error" | "warning";
  message: string;
}

interface ImportInfo {
  spec: string;
  status: "ok" | "error" | "warning";
  detail: string;
  bytes: number;
}

interface SourceInfo {
  path: string;
  kind: "global" | "project";
  lines: number;
  bytes: number;
  /** Expanded text: comments stripped, @imports inlined. What /rules show displays. */
  content: string;
  imports: ImportInfo[];
}

interface Expansion {
  cwd: string;
  sources: SourceInfo[];
  diagnostics: Diagnostic[];
  totalBytes: number;
  generated: string;
  limits: RulesConfig;
  settings: AppliedSetting[];
  fileStats: Map<string, string | null>; // canonical path -> stat key (null = missing) of every referenced file
}

// ============================================================================
// Helpers
// ============================================================================

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * pi's getAgentDir(): $PI_CODING_AGENT_DIR (tilde-expanded) or ~/.pi/agent.
 * Implemented locally so this extension has no runtime dependency on the
 * pi package (type-only imports are erased at runtime).
 */
function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return envDir.startsWith("~/") ? join(homedir(), envDir.slice(2)) : envDir;
  }
  return join(homedir(), ".pi", "agent");
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function displayPath(p: string): string {
  const home = homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function statKey(p: string): string | null {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

/** Resolve an import path: ~/... → home, /... → absolute, else relative to baseDir. */
function resolveImportPath(p: string, baseDir: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p.startsWith("/")) return p;
  return resolve(baseDir, p);
}

/** Parse a size string like "50", "50kb", "1.5mb" into bytes. Returns undefined on garbage. */
function parseByteSize(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|k|m|g)?$/i.exec(s.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "b").toLowerCase();
  const mult =
    unit === "b" ? 1 :
    unit === "k" || unit === "kb" ? 1024 :
    unit === "m" || unit === "mb" ? 1024 * 1024 :
    unit === "g" || unit === "gb" ? 1024 * 1024 * 1024 : 1;
  return Math.floor(n * mult);
}

/**
 * Handle an @rules directive: @rules <key> <value>. Keys are matched
 * leniently (max_depth / maxDepth / max-depth all work).
 */
function applyRulesDirective(
  spec: string,
  sourceFile: string,
  config: RulesConfig,
  settings: AppliedSetting[],
  diagnostics: Diagnostic[],
): void {
  const m = /^(\S+)\s+(.+)$/.exec(spec.trim());
  if (!m) {
    diagnostics.push({ level: "warning", message: `${sourceFile}: invalid @rules — expected "@rules <key> <value>"` });
    return;
  }
  const key = m[1].toLowerCase().replace(/[_-]/g, "");
  const value = m[2].trim();
  const record = () => settings.push({ source: sourceFile, key: m[1], value });
  switch (key) {
    case "maxdepth": {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 1) {
        diagnostics.push({ level: "warning", message: `${sourceFile}: @rules max_depth expects a positive integer, got "${value}"` });
        return;
      }
      config.maxDepth = n;
      record();
      return;
    }
    case "maxglobfiles": {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 1) {
        diagnostics.push({ level: "warning", message: `${sourceFile}: @rules max_glob_files expects a positive integer, got "${value}"` });
        return;
      }
      config.maxGlobFiles = n;
      record();
      return;
    }
    case "maxtotalbytes": {
      const n = parseByteSize(value);
      if (n === undefined || n < 1) {
        diagnostics.push({ level: "warning", message: `${sourceFile}: @rules max_total_bytes expects a size (e.g. 50kb), got "${value}"` });
        return;
      }
      config.maxTotalBytes = n;
      record();
      return;
    }
    default:
      diagnostics.push({
        level: "warning",
        message: `${sourceFile}: unknown @rules key "${m[1]}" — known: max_depth, max_glob_files, max_total_bytes`
      });
  }
}

// ============================================================================
// Comment stripping (depth-counted <!-- ... -->, unclosed runs to EOF)
// ============================================================================

function stripComments(text: string): { text: string; warnings: { line: number; message: string }[] } {
  const warnings: { line: number; message: string }[] = [];
  let out = "";
  let i = 0;
  let depth = 0;
  let commentStart = -1;
  while (i < text.length) {
    if (depth === 0) {
      const open = text.indexOf("<!--", i);
      if (open === -1) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, open);
      commentStart = open;
      depth = 1;
      i = open + 4;
    } else {
      const open = text.indexOf("<!--", i);
      const close = text.indexOf("-->", i);
      if (open !== -1 && (close === -1 || open < close)) {
        depth++; // nested-looking sequence: stay inside the comment
        i = open + 4;
      } else if (close !== -1) {
        depth--;
        i = close + 3;
      } else {
        i = text.length; // unclosed: rest of file is comment
      }
    }
  }
  if (depth > 0) {
    warnings.push({
      line: lineOf(text, commentStart),
      message: "unclosed comment <!-- (treated as comment to end of file)",
    });
  }
  return { text: out, warnings };
}

// ============================================================================
// Section extraction (#anchor)
// ============================================================================

function normalizeHeading(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/#+$/, "")
    .trim();
}

/**
 * Extract the section under the first heading whose normalized text matches
 * the anchor: from the heading line up to (not including) the next heading of
 * the same or higher level.
 */
function extractSection(text: string, anchor: string): { found: boolean; slice: string } {
  const lines = text.split(/\r?\n/);
  const target = normalizeHeading(anchor);
  let start = -1;
  let anchorLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i]);
    if (m && normalizeHeading(m[2]) === target) {
      start = i;
      anchorLevel = m[1].length;
      break;
    }
  }
  if (start === -1) return { found: false, slice: "" };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= anchorLevel) {
      end = i;
      break;
    }
  }
  return { found: true, slice: lines.slice(start, end).join("\n") };
}

// ============================================================================
// Glob matching (minimal, dependency-free: * ? and ** as a full segment)
// glob
// ============================================================================

function segToRegex(seg: string): RegExp {
  let s = "";
  for (const ch of seg) {
    if (ch === "*") s += "[^/]*";
    else if (ch === "?") s += "[^/]";
    else s += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + s + "$");
}

function walkGlob(dir: string, segs: string[], idx: number, out: string[]): void {
  if (idx >= segs.length) {
    if (statSync(dir).isFile()) out.push(dir);
    return;
  }
  const seg = segs[idx];
  if (seg === "**") {
    walkGlob(dir, segs, idx + 1, out); // zero depth
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const c = join(dir, e);
      if (statSync(c).isDirectory()) walkGlob(c, segs, idx, out); // consume one level, stay on **
    }
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  const re = segToRegex(seg);
  for (const e of entries) {
    if (e.startsWith(".") && !seg.startsWith(".")) continue;
    if (!re.test(e)) continue;
    const c = join(dir, e);
    if (idx === segs.length - 1) {
      if (statSync(c).isFile()) out.push(c);
    } else if (statSync(c).isDirectory()) {
      walkGlob(c, segs, idx + 1, out);
    }
  }
}

function globMatch(pattern: string, baseDir: string): { files: string[] } {
  const p = pattern.replace(/\\/g, "/");
  const abs = p.startsWith("/");
  const segs = p.split("/").filter((s) => s.length > 0);
  const wi = segs.findIndex((s) => s.includes("*") || s.includes("?"));
  if (wi === -1) {
    const f = resolveImportPath(p, baseDir);
    return { files: existsSync(f) && statSync(f).isFile() ? [f] : [] };
  }
  const base =
    abs || (segs[0] === "~" && segs.length > 1)
      ? join(homedir(), segs.slice(0, wi).join("/"))
      : resolve(baseDir, segs.slice(0, wi).join("/"));
  const files: string[] = [];
  if (existsSync(base) && statSync(base).isDirectory()) {
    walkGlob(base, segs.slice(wi), 0, files);
    files.sort();
  }
  return { files };
}

// ============================================================================
// Import expansion
// ============================================================================

function processDirectives(
  lines: string[],
  sourceFile: string,
  baseDir: string,
  depth: number,
  stack: Set<string>,
  imported: Set<string>,
  fileStats: Map<string, string | null>,
  config: RulesConfig,
  settings: AppliedSetting[],
  out: string[],
  imports: ImportInfo[],
  diagnostics: Diagnostic[],
): void {
  let inFence = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*(```+|~~~+)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const esc = /^(\s*)\\(@\w+.*)$/.exec(line);
    if (esc) {
      out.push(esc[1] + esc[2]); // literal, backslash dropped
      continue;
    }
    const rules = /^(\s*)@rules\s+(.+?)\s*$/.exec(line);
    if (rules) {
      applyRulesDirective(rules[2], sourceFile, config, settings, diagnostics);
      continue;
    }
    const m = /^(\s*)@import\s+(.+?)\s*$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    expandImport(m[2], sourceFile, baseDir, depth, stack, imported, fileStats, config, settings, out, imports, diagnostics);
  }
}

function expandImport(
  spec: string,
  sourceFile: string,
  baseDir: string,
  depth: number,
  stack: Set<string>,
  imported: Set<string>,
  fileStats: Map<string, string | null>,
  config: RulesConfig,
  settings: AppliedSetting[],
  out: string[],
  imports: ImportInfo[],
  diagnostics: Diagnostic[],
): void {
  const hashIdx = spec.indexOf("#");
  const pathPart = (hashIdx === -1 ? spec : spec.slice(0, hashIdx)).trim();
  const anchor = hashIdx === -1 ? undefined : spec.slice(hashIdx + 1).trim();

  const isGlob = pathPart.includes("*") || pathPart.includes("?");
  if (isGlob) {
    const { files } = globMatch(pathPart, baseDir);
    for (const f of files) fileStats.set(resolve(f), statKey(f));
    if (files.length === 0) {
      diagnostics.push({ level: "warning", message: `${sourceFile}: @import ${spec} — glob matched no files` });
      imports.push({ spec, status: "warning", detail: "glob matched no files", bytes: 0 });
      out.push(`[rules] skipped: ${spec} (glob matched no files)`);
      return;
    }
    if (files.length > config.maxGlobFiles) {
      diagnostics.push({
        level: "warning",
        message: `${sourceFile}: @import ${spec} — ${files.length} matches (> ${config.maxGlobFiles})`,
      });
    }
    let total = 0;
    for (const f of files) {
      const r = expandFile(f, anchor, depth + 1, stack, imported, fileStats, config, settings, diagnostics, sourceFile);
      if (r.ok) {
        out.push(r.text);
        total += r.bytes;
      } else {
        out.push(`[rules] skipped: ${spec} → ${displayPath(f)} (${r.reason})`);
      }
    }
    imports.push({
      spec,
      status: total > 0 ? (files.length > config.maxGlobFiles ? "warning" : "ok") : "error",
      detail: `${files.length} file${files.length > 1 ? "s" : ""}`,
      bytes: total,
    });
    return;
  }

  const p = resolveImportPath(pathPart, baseDir);
  fileStats.set(resolve(p), statKey(p));
  const r = expandFile(p, anchor, depth + 1, stack, imported, fileStats, config, settings, diagnostics, sourceFile);
  if (r.ok) {
    out.push(r.text);
    imports.push({ spec, status: "ok", detail: anchor ? "section" : "whole file", bytes: r.bytes });
  } else {
    imports.push({ spec, status: "error", detail: r.reason, bytes: 0 });
    out.push(`[rules] skipped: ${spec} (${r.reason})`);
  }
}

function expandFile(
  p: string,
  anchor: string | undefined,
  depth: number,
  stack: Set<string>,
  imported: Set<string>,
  fileStats: Map<string, string | null>,
  config: RulesConfig,
  settings: AppliedSetting[],
  diagnostics: Diagnostic[],
  sourceFile: string,
): { ok: true; text: string; bytes: number } | { ok: false; reason: string } {
  const canonical = resolve(p);
  fileStats.set(canonical, statKey(canonical));
  // settings inside an imported file affect only its own subtree
  const fileConfig = { ...config };
  if (depth > fileConfig.maxDepth) {
    diagnostics.push({ level: "error", message: `${sourceFile}: @import ${specLabel(p, anchor)} — max depth ${fileConfig.maxDepth} exceeded` });
    return { ok: false, reason: `max depth ${fileConfig.maxDepth} exceeded` };
  }
  if (stack.has(canonical)) {
    diagnostics.push({ level: "error", message: `${sourceFile}: @import ${specLabel(p, anchor)} — circular import` });
    return { ok: false, reason: "circular import" };
  }
  if (anchor === undefined && imported.has(canonical)) return { ok: false, reason: "already imported (deduped)" };
  if (!existsSync(canonical)) {
    diagnostics.push({ level: "error", message: `${sourceFile}: @import ${specLabel(p, anchor)} — file not found` });
    return { ok: false, reason: "file not found" };
  }

  const raw = stripBom(readFileSync(canonical, "utf-8"));
  const { text: noComments, warnings } = stripComments(raw);
  for (const w of warnings) {
    diagnostics.push({
      level: "warning",
      message: `${sourceFile}: @import ${specLabel(p, anchor)} — line ${w.line}: ${w.message}`,
    });
  }

  if (anchor !== undefined) {
    const { found, slice } = extractSection(noComments, anchor);
    if (!found) {
      diagnostics.push({ level: "error", message: `${sourceFile}: @import ${specLabel(p, anchor)} — section not found` });
      return { ok: false, reason: `section "#${anchor}" not found` };
    }
    return { ok: true, text: slice, bytes: slice.length };
  }

  stack.add(canonical);
  imported.add(canonical);
  const out: string[] = [];
  const nestedImports: ImportInfo[] = [];
  processDirectives(
    noComments.split("\n"),
    sourceFile,
    dirname(canonical),
    depth,
    stack,
    imported,
    fileStats,
    fileConfig,
    settings,
    out,
    nestedImports,
    diagnostics,
  );
  stack.delete(canonical);
  const text = out.join("\n");
  return { ok: true, text, bytes: text.length };
}

function specLabel(p: string, anchor: string | undefined): string {
  return anchor !== undefined ? `${displayPath(p)}#${anchor}` : displayPath(p);
}

// ============================================================================
// Expansion assembly (global + project RULES.md)
// ============================================================================

const PREAMBLE =
  "The following rules come from RULES.md, a user-maintained ground-truth file. " +
  "They are authoritative and stable: they change only when the user edits the file. " +
  "If a rule conflicts with the code you observe, ask the user to clarify — do not modify the rules file yourself.";

let cache: Expansion | undefined;

function computeExpansion(cwd: string): Expansion {
  const diagnostics: Diagnostic[] = [];
  const fileStats = new Map<string, string | null>();
  const stack = new Set<string>();
  const imported = new Set<string>();
  const sources: SourceInfo[] = [];
  const blocks: string[] = [];
  let totalBytes = 0;
  const config = defaultConfig();
  const settings: AppliedSetting[] = [];

  const candidates: { path: string; kind: "global" | "project" }[] = [
    { path: join(getAgentDir(), "RULES.md"), kind: "global" },
    { path: join(cwd, "RULES.md"), kind: "project" },
  ];

  for (const c of candidates) {
    // record the candidate regardless of existence so a newly created
    // or deleted RULES.md invalidates the cache
    fileStats.set(resolve(c.path), statKey(c.path));
    if (!existsSync(c.path)) continue;

    const raw = stripBom(readFileSync(c.path, "utf-8"));
    const { text: noComments, warnings } = stripComments(raw);
    for (const w of warnings) {
      diagnostics.push({ level: "warning", message: `${displayPath(c.path)} line ${w.line}: ${w.message}` });
    }

    const out: string[] = [];
    const imports: ImportInfo[] = [];
    processDirectives(
      noComments.split("\n"),
      displayPath(c.path),
      dirname(c.path),
      0,
      stack,
      imported,
      fileStats,
      config,
      settings,
      out,
      imports,
      diagnostics,
    );
    // Trim leading/trailing blank lines left behind by stripped comments
    // (a removed <!-- ... --> line still leaves its newline).
    const content = out.join("\n").trim();
    const lines = raw.split(/\r?\n/).length;
    sources.push({ path: displayPath(c.path), kind: c.kind, lines, bytes: content.length, content, imports });
    blocks.push(`<rules_source path="${displayPath(c.path)}">\n${content}\n</rules_source>`);
    totalBytes += content.length;
  }

  if (totalBytes > config.maxTotalBytes) {
    diagnostics.push({
      level: "warning",
      message: `total expanded size ${fmtBytes(totalBytes)} exceeds soft limit ${fmtBytes(config.maxTotalBytes)}`,
    });
  }

  const generated =
    sources.length === 0
      ? ""
      : `<rules_ground_truth>\n${PREAMBLE}\n\n${blocks.join("\n\n")}\n</rules_ground_truth>`;

  return { cwd, sources, diagnostics, totalBytes, generated, limits: config, settings, fileStats };
}

function cacheFresh(exp: Expansion): boolean {
  for (const [p, k] of exp.fileStats) {
    if (statKey(p) !== k) return false;
  }
  return true;
}

function getExpansion(cwd: string): Expansion | undefined {
  if (cache && cache.cwd === cwd && cacheFresh(cache)) return cache;
  cache = computeExpansion(cwd);
  return cache;
}

// ============================================================================
// /rules command
// ============================================================================

function statusMark(status: "ok" | "error" | "warning"): string {
  return status === "ok" ? "✓" : status === "error" ? "✗" : "⚠";
}

function buildReport(exp: Expansion | undefined): string[] {
  const lines: string[] = [];
  if (!exp || exp.sources.length === 0) {
    lines.push("No RULES.md found.");
    lines.push("Run /rules init to create a template.");
    return lines;
  }
  lines.push(
    `Rules: ${exp.sources.length} file(s) · expanded ${fmtBytes(exp.totalBytes)} · ~${Math.round(exp.totalBytes / 4)} tokens`,
  );
  lines.push(
    `limits: depth ${exp.limits.maxDepth} · glob ≤ ${exp.limits.maxGlobFiles} files · total ≤ ${fmtBytes(exp.limits.maxTotalBytes)}` +
    (exp.settings.length > 0 ? " · overridden in RULES.md" : " (defaults)"),
  );
  lines.push("");
  for (const s of exp.sources) {
    lines.push(`[${s.kind}]  ${s.path} — ${s.lines} lines · ${fmtBytes(s.bytes)}`);
    for (const imp of s.imports) {
      lines.push(
        `  ${statusMark(imp.status)} @import ${imp.spec} — ${imp.detail}${imp.bytes > 0 ? ` · ${fmtBytes(imp.bytes)}` : ""}`,
      );
    }
  }
  if (exp.settings.length > 0) {
    lines.push("");
    lines.push("Settings (from RULES.md):");
    for (const s of exp.settings) {
      lines.push(`  ⚙ ${s.key} = ${s.value} (${s.source})`);
    }
  }
  if (exp.diagnostics.length > 0) {
    lines.push("Diagnostics:");
    for (const d of exp.diagnostics) {
      lines.push(`  ${statusMark(d.level === "error" ? "error" : "warning")} ${d.message}`);
    }
  }
  const errs = exp.diagnostics.filter((d) => d.level === "error").length;
  const warns = exp.diagnostics.filter((d) => d.level === "warning").length;
  lines.push("");
  lines.push(`${errs} error(s) · ${warns} warning(s)`);
  return lines;
}

// ============================================================================
// Preview window (/rules show) — plain structural Component, lazy pi-tui
// ============================================================================

type PreviewDone = (result?: unknown) => void;
type PreviewMatchesKey = (data: string, key: KeyId) => boolean;
type PreviewTruncate = (text: string, maxWidth: number, ellipsis?: string, pad?: boolean) => string;
interface PreviewKeys {
  up: KeyId;
  down: KeyId;
  pageUp: KeyId;
  pageDown: KeyId;
  home: KeyId;
  end: KeyId;
  escape: KeyId;
}

/**
 * Flatten expanded sources into one window: a header line per source plus
 * its expanded content. Empty when no RULES.md exists.
 */
export function buildPreviewBlocks(exp: Expansion | undefined): { title: string; lines: string[] } {
  if (!exp || exp.sources.length === 0) return { title: "RULES.md (expanded)", lines: [] };
  const lines: string[] = [];
  for (const s of exp.sources) {
    const impNote = s.imports.length > 0 ? ` · ${s.imports.length} import(s)` : "";
    lines.push(`─ [${s.kind}] ${s.path} — ${s.lines} lines · expanded ${fmtBytes(s.bytes)}${impNote}`);
    lines.push(...s.content.split("\n"));
    lines.push("");
  }
  return {
    title: `RULES.md (expanded) — ${exp.sources.length} file(s) · ${fmtBytes(exp.totalBytes)} · ~${Math.round(exp.totalBytes / 4)} tokens`,
    lines,
  };
}

/**
 * Scrollable bordered window as a plain structural Component (no pi-tui
 * classes — keeps this file importable by tests with plain Node). All
 * pi-tui functions are injected. Overlay by default; full screen when
 * fullScreen is true.
 */
export function makePreviewWindow(
  tui: { terminal: { rows: number }; requestRender: (force?: boolean) => void },
  theme: Theme,
  done: PreviewDone,
  title: string,
  lines: string[],
  truncate: PreviewTruncate,
  visibleWidth: (text: string) => number,
  matchesKey: PreviewMatchesKey,
  keys: PreviewKeys,
  fullScreen: boolean,
): { render: (width: number) => string[]; handleInput: (data: string) => void; invalidate: () => void } {
  const contentHeight = () => {
    const rows = tui.terminal.rows;
    // full-screen: rough editor-area estimate; overlay: keep under maxHeight.
    // Both leave room for the top and bottom border lines.
    return Math.max(3, Math.floor(fullScreen ? rows - 10 : rows * 0.85 - 4));
  };
  let offset = 0;
  const clamp = () => {
    const max = Math.max(0, lines.length - contentHeight());
    if (offset > max) offset = max;
    if (offset < 0) offset = 0;
  };
  // ┌─ title ────────┐  (title styled accent, border dim)
  const topBorder = (width: number): string => {
    const t = theme.fg("accent", ` ${truncate(title, Math.max(4, width - 8), "…")} `);
    const fill = Math.max(1, width - 3 - visibleWidth(t));
    return theme.fg("dim", "┌─") + t + theme.fg("dim", "─".repeat(fill) + "┐");
  };
  // └─ status ───────┘
  const bottomBorder = (text: string, width: number): string => {
    const t = theme.fg("dim", truncate(text, Math.max(4, width - 6), "…"));
    const fill = Math.max(1, width - 3 - visibleWidth(t));
    return theme.fg("dim", "└─") + t + theme.fg("dim", "─".repeat(fill) + "┘");
  };

  return {
    render(width: number): string[] {
      clamp();
      const h = contentHeight();
      const inner = Math.max(1, width - 2);
      const out: string[] = [topBorder(width)];
      const bar = theme.fg("dim", "│");
      for (let i = offset; i < offset + h && i < lines.length; i++) {
        out.push(`${bar}${truncate(lines[i] ?? "", inner, "", true)}${bar}`);
      }
      while (out.length < h + 1) out.push(`${bar}${' '.repeat(inner)}${bar}`);
      const first = offset + 1;
      const last = Math.min(offset + h, lines.length);
      const pct = lines.length > 0 ? Math.round((offset / Math.max(1, lines.length - h)) * 100) : 0;
      out.push(bottomBorder(` ${first}–${last} / ${lines.length} (${pct}%) · ↑↓ PgUp/PgDn Home/End · Esc `, width));
      return out;
    },
    handleInput(data: string): void {
      if (matchesKey(data, keys.escape)) {
        done();
        return;
      }
      if (matchesKey(data, keys.up)) {
        offset--;
        clamp();
        tui.requestRender();
        return;
      }
      if (matchesKey(data, keys.down)) {
        offset++;
        clamp();
        tui.requestRender();
        return;
      }
      if (matchesKey(data, keys.pageUp)) {
        offset -= contentHeight();
        clamp();
        tui.requestRender();
        return;
      }
      if (matchesKey(data, keys.pageDown)) {
        offset += contentHeight();
        clamp();
        tui.requestRender();
        return;
      }
      if (matchesKey(data, keys.home)) {
        offset = 0;
        tui.requestRender();
        return;
      }
      if (matchesKey(data, keys.end)) {
        offset = lines.length;
        clamp();
        tui.requestRender();
        return;
      }
    },
    invalidate(): void {
      // no cached render state
    },
  };
}


// ============================================================================
// Extension registration
// ============================================================================

export default function rulesExtension(pi: ExtensionAPI): void {
  // Inject expanded rules into the system prompt before every agent turn.
  pi.on("before_agent_start", (event, ctx) => {
    const exp = getExpansion(ctx.cwd);
    if (!exp || !exp.generated) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + exp.generated };
  });

  pi.registerCommand("rules", {
    description:
      "Manage RULES.md ground-truth rules: list loaded rules and diagnostics, init a template, reload into the system prompt",
    getArgumentCompletions: async (prefix) => {
      const opts = [
        { value: "list", label: "list", description: "Show loaded RULES.md files, imports, and diagnostics" },
        { value: "show", label: "show", description: "Preview expanded rules in a scrollable window (full = full screen, Esc closes)" },
        { value: "init", label: "init", description: "Create a RULES.md template (--force overwrites, -g writes global)" },
        { value: "reload", label: "reload", description: "Re-read RULES.md files and rebuild the system prompt" },
      ];
      return opts
        .filter((o) => o.value.startsWith(prefix) || `${o.value} `.startsWith(prefix))
        .map((o) => ({ value: o.value, label: o.label, description: o.description }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.setWidget("rules-report", undefined); // clear any previous report
      const argv = args.trim().split(/\s+/).filter(Boolean);
      const cmd = argv[0] ?? "list";

      if (cmd === "list") {
        const exp = getExpansion(ctx.cwd);
        const report = buildReport(exp);
        if (ctx.hasUI && ctx.mode === "tui") {
          ctx.ui.setWidget("rules-report", report);
          ctx.ui.notify(
            `Rules: ${exp && exp.sources.length > 0 ? exp.sources.length : 0} file(s) loaded — dismiss widget or run /rules again`,
            "info",
          );
        } else {
          ctx.ui.notify(report.join("\n"), "info");
        }
        return;
      }

      if (cmd === "show") {
        const exp = getExpansion(ctx.cwd);
        if (!ctx.hasUI || ctx.mode !== "tui") {
          ctx.ui.notify("show requires the TUI — use list for the text report", "error");
          return;
        }
        const { title, lines } = buildPreviewBlocks(exp);
        if (lines.length === 0) {
          ctx.ui.notify("No RULES.md found — run /rules init to create a template", "error");
          return;
        }
        if (typeof ctx.ui.custom !== "function") {
          ctx.ui.notify("Preview unavailable in this UI — use list for the text report", "error");
          return;
        }
        // Lazy runtime import: resolved by pi's jiti alias to pi's bundled
        // pi-tui. In plain-Node tests this import fails and we degrade to
        // a notify instead of throwing.
        let tui: typeof import("@earendil-works/pi-tui");
        try {
          tui = await import("@earendil-works/pi-tui");
        } catch {
          ctx.ui.notify("Preview unavailable (pi-tui not resolvable) — use list", "error");
          return;
        }
        const { matchesKey, Key, truncateToWidth, visibleWidth } = tui;
        const keys: PreviewKeys = {
          up: Key.up,
          down: Key.down,
          pageUp: Key.pageUp,
          pageDown: Key.pageDown,
          home: Key.home,
          end: Key.end,
          escape: Key.escape,
        };
        const fullScreen = argv.includes("full");
        await ctx.ui.custom(
          (tuiInstance, theme, _kb, done) =>
            makePreviewWindow(tuiInstance, theme, done, title, lines, truncateToWidth, visibleWidth, matchesKey, keys, fullScreen),
          fullScreen
            ? undefined
            : { overlay: true, overlayOptions: { width: "80%", maxHeight: "85%", margin: 2 } },
        );
        return;
      }

      if (cmd === "init") {
        const force = argv.includes("--force");
        const global = argv.includes("-g") || argv.includes("--global");
        const target = global ? join(getAgentDir(), "RULES.md") : join(ctx.cwd, "RULES.md");
        if (existsSync(target) && !force) {
          ctx.ui.notify(`RULES.md already exists at ${displayPath(target)} — use --force to overwrite`, "error");
          return;
        }
        writeFileSync(target, TEMPLATE);
        ctx.ui.notify(`Created ${displayPath(target)} — run /rules reload to apply`, "info");
        return;
      }

      if (cmd === "reload") {
        cache = undefined;
        ctx.ui.notify("Reloading rules and resources…", "info");
        await ctx.reload();
        return;
      }

      ctx.ui.notify(`Unknown subcommand "${cmd}" — use list | show | init | reload`, "error");
    },
  });
}
