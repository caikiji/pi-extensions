/**
 * checkpoint — git-backed snapshot / restore for agent edits.
 *
 * Lets the agent (and the user) save a "save point" before risky work and
 * restore just the files that changed since then, without touching unrelated
 * uncommitted changes. Think of it as an undo button for multi-file work.
 *
 * Usage:
 *   /checkpoint               list checkpoints
 *   /checkpoint <msg>         save a named checkpoint
 *   /checkpoint drop <id|all> delete checkpoint(s)
 *   /restore <id|latest>      restore a checkpoint (--force overrides conflicts)
 *
 * Implementation:
 *   - `git stash create` snapshots the tracked working tree as a commit object
 *     without touching the worktree; the sha is kept alive via
 *     refs/pi-checkpoints/<id>. Entries with no tracked changes still capture
 *     untracked files (their sha is "").
 *   - All git commands run from the repo root (resolved via --show-toplevel),
 *     so the extension works from any cwd inside or outside the repo.
 *   - Tracked files are restored with `git restore --source=<sha> --worktree --staged`.
 *   - Untracked (new) files are copied into .git/pi-checkpoints/<id>/untracked/
 *     at snapshot time and copied back on restore.
 *   - Restore refuses (unless --force) any file whose current content differs
 *     from the snapshot — that means you changed it too (a batched,
 *     filter-aware `git diff` catches edits, staged changes, and reverts
 *     to HEAD).
 *   - An automatic checkpoint is taken at every turn_start (ring of 20), so the
 *     agent always has a recent save point even without asking.
 *
 * Prompt integration: promptSnippet opts checkpoint_list / checkpoint_restore
 * into the system prompt's Available tools section (without it custom tools
 * are invisible there), and promptGuidelines on checkpoint_restore add flat
 * "save before risky work / restore after failures" bullets to the Guidelines
 * section so the model reaches for the tools when they are relevant.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

export interface CheckpointEntry {
	id: string;
	msg: string;
	ts: number; // epoch ms
	sha: string;
	tracked: string[]; // paths relative to the repo root, changed vs HEAD
	untracked: string[]; // new files captured alongside
	skipped: string[]; // untracked files skipped (too large / too many)
	auto: boolean;
}

export interface RestoreResult {
	ok: boolean;
	restored: string[];
	conflicts: string[];
	wouldDelete: string[]; // files deleted in the snapshot; removed only with force
	id?: string; // restored checkpoint id
	error?: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ExecResult>;

interface State {
	entries: CheckpointEntry[];
}

// ============================================================================
// Git plumbing helpers
// ============================================================================

async function execOk(exec: ExecFn, cwd: string, cmd: string, args: string[]): Promise<ExecResult> {
	const res = await exec(cmd, args, { cwd });
	if (res.code !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
	}
	return res;
}

/** Repo root for a cwd, or null if not inside a repo. Cached. */
const rootCache = new Map<string, string | null>();
async function getRepoRoot(exec: ExecFn, cwd: string): Promise<string | null> {
	const hit = rootCache.get(cwd);
	if (hit !== undefined) return hit;
	try {
		const res = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
		const root = res.code === 0 ? res.stdout.trim() : "";
		rootCache.set(cwd, root || null);
		return root || null;
	} catch {
		rootCache.set(cwd, null);
		return null;
	}
}

/** Absolute path of the git dir for a repo root, or null if not a repo. Cached. */
const gitDirCache = new Map<string, string | null>();
async function getGitDir(exec: ExecFn, root: string): Promise<string | null> {
	const hit = gitDirCache.get(root);
	if (hit !== undefined) return hit;
	try {
		const res = await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: root });
		const dir = res.code === 0 ? res.stdout.trim() : "";
		gitDirCache.set(root, dir || null);
		return dir || null;
	} catch {
		gitDirCache.set(root, null);
		return null;
	}
}

function stateDirOf(gitDir: string): string {
	return join(gitDir, "pi-checkpoints");
}

function stateFileOf(gitDir: string): string {
	return join(stateDirOf(gitDir), "state.json");
}

function loadState(gitDir: string): State {
	try {
		const raw = readFileSync(stateFileOf(gitDir), "utf8");
		const parsed = JSON.parse(raw) as State;
		if (Array.isArray(parsed.entries)) return parsed;
	} catch {
		// no state yet
	}
	return { entries: [] };
}

function saveState(gitDir: string, state: State): void {
	mkdirSync(stateDirOf(gitDir), { recursive: true });
	const tmp = stateFileOf(gitDir) + ".tmp";
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	renameSync(tmp, stateFileOf(gitDir));
}

/** sha1 of a file's raw bytes, or null if missing/unreadable. */
function sha1File(path: string): string | null {
	try {
		return createHash("sha1").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
}

const UNTRACKED_MAX_FILES = 200;
const UNTRACKED_MAX_BYTES = 10 * 1024 * 1024;
const UNTRACKED_MAX_FILE_BYTES = 1024 * 1024;
const AUTO_RING = 20;
const MANUAL_MAX = 100;

function makeId(auto: boolean): string {
	const stamp = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 6);
	return auto ? `auto-${stamp}-${rand}` : `cp-${stamp}-${rand}`;
}

// ============================================================================
// Core operations
// ============================================================================

export async function createCheckpoint(exec: ExecFn, cwd: string, msg: string, auto = false): Promise<CheckpointEntry | null> {
	const root = await getRepoRoot(exec, cwd);
	if (!root) return null;
	const gitDir = await getGitDir(exec, root);
	if (!gitDir) return null;

	// `git stash create` returns "" when the tracked tree is clean and fails
	// on a fresh repo with no initial commit (only untracked files exist).
	let sha = "";
	const shaRes = await exec(
		"git",
		["-c", "user.name=pi", "-c", "user.email=pi@local", "stash", "create", msg || (auto ? "auto" : "checkpoint")],
		{ cwd: root },
	);
	if (shaRes.code !== 0) {
		const headRes = await exec("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: root });
		if (headRes.code !== 0) sha = ""; // fresh repo: untracked-only capture below
		else return null; // real failure
	} else {
		sha = shaRes.stdout.trim();
	}

	const id = makeId(auto);

	// Files changed vs HEAD (first parent of the stash commit).
	const tracked: string[] = [];
	if (sha) {
		const diffRes = await execOk(exec, root, "git", ["diff-tree", "-r", "--name-only", "-z", `${sha}^`, sha]);
		tracked.push(...diffRes.stdout.split("\0").filter(Boolean));
	}

	// Capture untracked files (new files the agent created).
	const untracked: string[] = [];
	const skipped: string[] = [];
	const untrackedRes = await execOk(exec, root, "git", ["ls-files", "--others", "--exclude-standard", "-z"]);
	const candidates = untrackedRes.stdout.split("\0").filter(Boolean);
	let totalBytes = 0;
	for (const rel of candidates) {
		if (untracked.length >= UNTRACKED_MAX_FILES) {
			skipped.push(rel);
			continue;
		}
		let st: ReturnType<typeof statSync> | undefined;
		try {
			st = statSync(join(root, rel));
		} catch {
			continue;
		}
		if (!st.isFile()) continue;
		if (st.size > UNTRACKED_MAX_FILE_BYTES || totalBytes + st.size > UNTRACKED_MAX_BYTES) {
			skipped.push(rel);
			continue;
		}
		const dest = join(stateDirOf(gitDir), id, "untracked", rel);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(join(root, rel), dest);
		totalBytes += st.size;
		untracked.push(rel);
	}

	// Nothing changed at all: no tracked diff and no untracked files.
	if (!sha && untracked.length === 0) return null;

	// Keep the snapshot commit alive against gc (untracked-only entries have no sha).
	if (sha) await execOk(exec, root, "git", ["update-ref", `refs/pi-checkpoints/${id}`, sha]);

	const entry: CheckpointEntry = { id, msg: msg || (auto ? "auto" : "checkpoint"), ts: Date.now(), sha, tracked, untracked, skipped, auto };

	const state = loadState(gitDir);
	state.entries.push(entry);
	state.entries.sort((a, b) => b.ts - a.ts);

	// Prune: keep the newest AUTO_RING auto checkpoints, drop the rest.
	const autoEntries = state.entries.filter((e) => e.auto);
	const toDropAuto = autoEntries.slice(AUTO_RING);
	for (const e of toDropAuto) {
		if (e.sha) await exec("git", ["update-ref", "-d", `refs/pi-checkpoints/${e.id}`], { cwd: root });
		rmSync(join(stateDirOf(gitDir), e.id), { recursive: true, force: true });
	}
	state.entries = state.entries.filter((e) => !toDropAuto.some((d) => d.id === e.id));

	// Manual entries are capped too (keep newest MANUAL_MAX).
	const manual = state.entries.filter((e) => !e.auto);
	const toDropManual = manual.slice(MANUAL_MAX);
	for (const e of toDropManual) {
		if (e.sha) await exec("git", ["update-ref", "-d", `refs/pi-checkpoints/${e.id}`], { cwd: root });
		rmSync(join(stateDirOf(gitDir), e.id), { recursive: true, force: true });
	}
	state.entries = state.entries.filter((e) => !toDropManual.some((d) => d.id === e.id));

	saveState(gitDir, state);
	return entry;
}

export async function listCheckpoints(exec: ExecFn, cwd: string): Promise<CheckpointEntry[]> {
	const root = await getRepoRoot(exec, cwd);
	if (!root) return [];
	const gitDir = await getGitDir(exec, root);
	if (!gitDir) return [];
	const state = loadState(gitDir);
	return state.entries.sort((a, b) => b.ts - a.ts);
}

export async function restoreCheckpoint(
	exec: ExecFn,
	cwd: string,
	idOrLatest: string,
	opts: { force?: boolean } = {},
): Promise<RestoreResult> {
	const root = await getRepoRoot(exec, cwd);
	if (!root) return { ok: false, restored: [], conflicts: [], wouldDelete: [], error: `not a git repository (cwd: ${cwd}) - run pi inside the repo or pass repo=<path>` };
	const gitDir = await getGitDir(exec, root);
	if (!gitDir) return { ok: false, restored: [], conflicts: [], wouldDelete: [], error: `not a git repository (cwd: ${cwd}) - run pi inside the repo or pass repo=<path>` };

	const state = loadState(gitDir);
	let entry: CheckpointEntry | undefined;
	// 'latest' skips pre-restore snapshots (internal restore side-effects).
	if (idOrLatest === "latest") entry = state.entries.find((e) => !e.msg.startsWith("pre-restore"));
	else entry = state.entries.find((e) => e.id === idOrLatest || e.id.startsWith(idOrLatest));
	if (!entry) {
		const ids = state.entries.slice(0, 8).map((e) => e.id).join(", ");
		return { ok: false, restored: [], conflicts: [], wouldDelete: [], error: `checkpoint not found: ${idOrLatest} (known: ${ids || "none"})` };
	}

	const force = opts.force ?? false;
	const conflicts: string[] = [];
	const restored: string[] = [];
	const wouldDelete: string[] = [];
	const restoreable: string[] = [];

	// Split tracked paths into "present in the snapshot tree" (restore them
	// from the commit) vs "deleted in the snapshot" (remove with --force).
	let present: string[] = [];
	if (entry.sha) {
		const treeRes = await execOk(exec, root, "git", ["ls-tree", "-r", "--name-only", entry.sha]);
		const treePaths = new Set(treeRes.stdout.split("\n").filter(Boolean));
		present = entry.tracked.filter((rel) => treePaths.has(rel));
		for (const rel of entry.tracked) {
			if (!treePaths.has(rel) && existsSync(join(root, rel))) wouldDelete.push(rel);
		}
	}

	// Tracked conflicts: one batched, filter-aware `git diff` between the
	// snapshot and the current index+worktree (catches edits, staged changes,
	// and reverts to HEAD). Deletions (D) are excluded - restoring recreates
	// a file that was deleted since the checkpoint.
	if (entry.sha && present.length > 0) {
		const diffRes = await exec("git", ["diff", "--name-only", "--diff-filter=AMT", "--no-renames", entry.sha, "--", ...present], { cwd: root });
		if (diffRes.code === 0) {
			const dirty = new Set(diffRes.stdout.split("\n").filter(Boolean));
			for (const rel of present) {
				if (dirty.has(rel)) {
					if (!force) {
						conflicts.push(rel);
						continue;
					}
					// force: overwrite below
				}
				restoreable.push(rel);
			}
		} else {
			// diff failed (e.g. missing tree): refuse everything
			if (!force) conflicts.push(...present);
			else restoreable.push(...present);
		}
	}

	// Untracked files: compare current content vs stored copy (raw sha1).
	const untrackedOk: string[] = [];
	for (const rel of entry.untracked) {
		const stored = join(stateDirOf(gitDir), entry.id, "untracked", rel);
		if (!existsSync(stored)) continue;
		const curHash = sha1File(join(root, rel));
		const snapHash = sha1File(stored);
		if (curHash !== null && curHash !== snapHash) {
			if (!force) {
				conflicts.push(rel);
				continue;
			}
			// force: overwrite below
		}
		untrackedOk.push(rel);
	}

	if (conflicts.length > 0 && !force) {
		return {
			ok: false,
			restored: [],
			conflicts,
			wouldDelete,
			id: entry.id,
			error: `${conflicts.length} file(s) changed since the checkpoint - use --force to overwrite them`,
		};
	}

	// Save a pre-restore snapshot so the restore itself can be undone.
	// Best-effort: never block the restore on snapshot failure.
	try {
		await createCheckpoint(exec, root, `pre-restore ${entry.id}`, false);
	} catch {
		// ignore
	}

	// Apply: tracked files from the snapshot commit (worktree + index).
	if (entry.sha && restoreable.length > 0) {
		await execOk(exec, root, "git", ["restore", "--source=" + entry.sha, "--worktree", "--staged", "--", ...restoreable]);
	}
	restored.push(...restoreable);

	// Apply: untracked files from the stored copies.
	for (const rel of untrackedOk) {
		const stored = join(stateDirOf(gitDir), entry.id, "untracked", rel);
		const dest = join(root, rel);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(stored, dest);
		restored.push(rel);
	}

	// Deleted-in-snapshot files: only remove with --force.
	if (wouldDelete.length > 0) {
		if (force) {
			for (const rel of wouldDelete) rmSync(join(root, rel), { force: true });
			restored.push(...wouldDelete.map((r) => `${r} (deleted)`));
			wouldDelete.length = 0;
		}
	}

	return { ok: true, restored, conflicts, wouldDelete, id: entry.id };
}

export async function dropCheckpoint(exec: ExecFn, cwd: string, idOrAll: string): Promise<string[]> {
	const root = await getRepoRoot(exec, cwd);
	if (!root) return [];
	const gitDir = await getGitDir(exec, root);
	if (!gitDir) return [];
	const state = loadState(gitDir);
	const targets = idOrAll === "all" ? state.entries : state.entries.filter((e) => e.id === idOrAll || e.id.startsWith(idOrAll));
	const dropped: string[] = [];
	for (const e of targets) {
		if (e.sha) await exec("git", ["update-ref", "-d", `refs/pi-checkpoints/${e.id}`], { cwd: root });
		rmSync(join(stateDirOf(gitDir), e.id), { recursive: true, force: true });
		dropped.push(e.id);
	}
	if (dropped.length > 0) {
		state.entries = state.entries.filter((e) => !dropped.includes(e.id));
		saveState(gitDir, state);
	}
	return dropped;
}

// ============================================================================
// Formatting
// ============================================================================

function fmtTs(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatEntries(entries: CheckpointEntry[], full = false): string {
	if (entries.length === 0) return "no checkpoints yet - /checkpoint <msg> to save one";
	const rows = entries.map((e) => {
		const tag = e.auto ? "[auto] " : "";
		const utag = !e.sha && e.untracked.length > 0 ? "[untracked-only] " : "";
		const files = e.tracked.length + e.untracked.length;
		const skip = e.skipped.length > 0 ? ` (+${e.skipped.length} skipped)` : "";
		let row = `${e.id}  ${fmtTs(e.ts)}  ${tag}${utag}${e.msg} | ${files} file${files === 1 ? "" : "s"}${skip}`;
		if (full && files > 0) {
			row += "\n    " + [...e.tracked, ...e.untracked].slice(0, 12).join("  ");
			if (e.tracked.length + e.untracked.length > 12) row += "  ...";
		}
		return row;
	});
	return rows.join("\n");
}

// ============================================================================
// Extension registration
// ============================================================================

interface CheckpointParams {
	json?: boolean;
	full?: boolean; // include per-checkpoint file lists in text output
	repo?: string; // repo dir (relative to cwd or absolute) when the session cwd is outside the repo
}

interface RestoreParams {
	id: string;
	force?: boolean;
	repo?: string; // repo dir (relative to cwd or absolute) when the session cwd is outside the repo
}

export default async function checkpointExtension(pi: ExtensionAPI): Promise<void> {
	let schema: object | undefined;
	let restoreSchema: object | undefined;
	try {
		const { Type } = await import("typebox");
		schema = Type.Object({
			json: Type.Optional(Type.Boolean({ description: "Return machine-readable JSON" })),
			full: Type.Optional(Type.Boolean({ description: "Include per-checkpoint file lists in text output" })),
			repo: Type.Optional(Type.String({ description: "Repo directory (relative to cwd or absolute) - use when the session cwd is outside the repo" })),
		});
		restoreSchema = Type.Object({
			id: Type.String({ description: "Checkpoint id, id prefix, or 'latest'" }),
			force: Type.Optional(Type.Boolean({ description: "Overwrite files you changed after the checkpoint" })),
			repo: Type.Optional(Type.String({ description: "Repo directory (relative to cwd or absolute) - use when the session cwd is outside the repo" })),
		});
	} catch {
		// typebox unavailable (plain-Node tests) — pi always has it
	}

	// Automatic save point before every agent turn (git repos only, silent).
	// Also track the session cwd so argument completions can list real
	// checkpoint ids (getArgumentCompletions has no ctx of its own).
	let lastCwd: string | undefined;
	pi.on("turn_start", async (_event, ctx) => {
		lastCwd = ctx.cwd;
		try {
			await createCheckpoint((cmd, args, opts) => pi.exec(cmd, args, opts), ctx.cwd, "auto", true);
		} catch {
			// never break the turn for a checkpoint failure
		}
	});

	pi.registerTool({
		name: "checkpoint_list",
		label: "List checkpoints",
		description: "List git checkpoints (save points) for the current repo with id, time, message, and file counts.",
		// One-liner for the system prompt's Available tools section - without it
		// custom tools are left out entirely and the model never considers them.
		promptSnippet:
			"List git checkpoints (save points) for the current repo with id, time, message, and file counts.",
		parameters: (schema ?? {}) as never,
		async execute(_toolCallId, params: CheckpointParams, _signal, _onUpdate, ctx) {
			try {
				const exec = (cmd: string, args: string[], opts?: { cwd?: string }) => pi.exec(cmd, args, opts);
				const cwd = params.repo ? resolve(ctx.cwd, params.repo) : ctx.cwd;
				const root = await getRepoRoot(exec, cwd);
				if (!root) {
					return { content: [{ type: "text", text: `not a git repository (cwd: ${cwd}) - run pi inside the repo or pass repo=<path>` }], details: {}, isError: true };
				}
				const entries = await listCheckpoints(exec, cwd);
				const text = params.json ? JSON.stringify(entries) : formatEntries(entries, params.full);
				return { content: [{ type: "text", text }], details: {} };
			} catch (err) {
				return {
					content: [{ type: "text", text: `checkpoint_list: ${err instanceof Error ? err.message : String(err)}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "checkpoint_restore",
		label: "Restore checkpoint",
		description:
			"Restore a git checkpoint: reverts exactly the files it captured (tracked + untracked) without touching unrelated uncommitted changes. Refuses files you modified after the checkpoint unless force=true. Use id 'latest' for the most recent.",
		// One-liner for the system prompt's Available tools section.
		promptSnippet:
			"Restore a git checkpoint: reverts exactly the files it captured without touching unrelated uncommitted changes; files changed after the checkpoint need force=true.",
		// Flat bullets in the system prompt's Guidelines section; each must name the
		// tool explicitly. Put them on checkpoint_restore (the main action tool) so
		// they appear once, not duplicated per tool.
		promptGuidelines: [
			"Before risky or multi-file edits, recommend the user save a checkpoint with /checkpoint <msg> (an automatic save point also exists for every turn), so the work can be undone later.",
			"When edits went wrong or an experiment failed, call checkpoint_restore with id 'latest' to revert exactly the files captured since the save point; unrelated uncommitted changes are never touched, and files you changed after the checkpoint are refused unless force=true.",
			"When a specific save point is needed, call checkpoint_list first to see ids, times, messages, and file counts; pass the repo parameter when the session cwd is outside the git repository.",
		],
		parameters: (restoreSchema ?? {}) as never,
		async execute(_toolCallId, params: RestoreParams, _signal, _onUpdate, ctx) {
			try {
				const exec = (cmd: string, args: string[], opts?: { cwd?: string }) => pi.exec(cmd, args, opts);
				const cwd = params.repo ? resolve(ctx.cwd, params.repo) : ctx.cwd;
				const res = await restoreCheckpoint(exec, cwd, params.id, { force: params.force });
				const lines: string[] = [];
				if (res.error) lines.push(`error: ${res.error}`);
				if (res.ok && res.restored.length > 0) lines.push(`restored checkpoint ${res.id}: ${res.restored.length} file(s)`);
				if (res.conflicts.length > 0) lines.push(`conflicts (not touched): ${res.conflicts.join(", ")}`);
				if (res.wouldDelete.length > 0) lines.push(`would delete (need --force): ${res.wouldDelete.join(", ")}`);
				return {
					content: [{ type: "text", text: lines.join("\n") || (res.ok ? "nothing to restore" : "restore failed") }],
					details: { ok: res.ok, id: res.id, restored: res.restored, conflicts: res.conflicts },
					isError: !res.ok,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `checkpoint_restore: ${err instanceof Error ? err.message : String(err)}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("checkpoint", {
		description: "Git save points for agent edits: /checkpoint <msg> saves, /checkpoint lists, /checkpoint drop <id|all> removes",
		getArgumentCompletions: async (prefix) => {
			const trimmed = prefix.trim();
			// Second level: "list --full" and "drop <target>" — values replace the
			// whole argument text, so they carry the subcommand prefix.
			if (trimmed.startsWith("list")) {
				const rest = trimmed.slice("list".length).trim();
				const items = [{ value: "list --full", label: "--full", description: "Show per-checkpoint file lists" }];
				return items.filter((o) => o.value.startsWith(trimmed) || `${o.value} `.startsWith(trimmed) || rest === "");
			}
			if (trimmed.startsWith("drop")) {
				const rest = trimmed.slice("drop".length).trim();
				const items = [{ value: "drop all", label: "all", description: "Drop all checkpoints" }];
				if (lastCwd) {
					const entries = await listCheckpoints((cmd, args, opts) => pi.exec(cmd, args, opts), lastCwd);
					for (const e of entries.slice(0, 8)) {
						items.push({ value: `drop ${e.id}`, label: e.id, description: `${fmtTs(e.ts)} ${e.msg}` });
					}
				}
				return items.filter((o) => o.value.startsWith(trimmed) || `${o.value} `.startsWith(trimmed) || rest === "");
			}
			// First level: subcommands (a free-text message gets no completion).
			const opts = [
				{ value: "list", label: "list", description: "List checkpoints (default when no args)" },
				{ value: "drop", label: "drop", description: "Drop checkpoint(s): drop all | drop <id>" },
			];
			return opts.filter((o) => o.value.startsWith(trimmed) || `${o.value} `.startsWith(trimmed));
		},
		handler: async (args: string, ctx) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const exec = (cmd: string, a: string[], opts?: { cwd?: string }) => pi.exec(cmd, a, opts);
			try {
				if (argv.length === 0 || argv[0] === "list") {
					const entries = await listCheckpoints(exec, ctx.cwd);
					const text = formatEntries(entries, argv.includes("--full"));
					ctx.ui.notify(entries.length === 0 ? `${text} (cwd: ${ctx.cwd})` : text, "info");
					return;
				}
				if (argv[0] === "drop") {
					const target = argv[1];
					if (!target) {
						ctx.ui.notify("Usage: /checkpoint drop <id|all>", "error");
						return;
					}
					const dropped = await dropCheckpoint(exec, ctx.cwd, target);
					ctx.ui.notify(dropped.length > 0 ? `dropped ${dropped.length} checkpoint(s)` : "nothing dropped", "info");
					return;
				}
				const entry = await createCheckpoint(exec, ctx.cwd, argv.join(" "), false);
				ctx.ui.notify(entry ? `checkpoint ${entry.id} saved (${entry.tracked.length + entry.untracked.length} files)` : "nothing to checkpoint (clean worktree?)", "info");
			} catch (err) {
				ctx.ui.notify(`checkpoint: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("restore", {
		description: "Restore a checkpoint: /restore <id|latest> [--force]",
		getArgumentCompletions: async (prefix) => {
			const trimmed = prefix.trim();
			const items = [
				{ value: "latest", label: "latest", description: "Most recent checkpoint" },
				{ value: "--force", label: "--force", description: "Overwrite files changed after the checkpoint" },
			];
			if (lastCwd) {
				const entries = await listCheckpoints((cmd, args, opts) => pi.exec(cmd, args, opts), lastCwd);
				for (const e of entries.slice(0, 8)) {
					items.push({ value: e.id, label: e.id, description: `${fmtTs(e.ts)} ${e.msg}` });
				}
			}
			return items.filter((o) => o.value.startsWith(trimmed) || `${o.value} `.startsWith(trimmed));
		},
		handler: async (args: string, ctx) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const id = argv.find((a) => !a.startsWith("--"));
			const force = argv.includes("--force");
			if (!id) {
				ctx.ui.notify("Usage: /restore <id|latest> [--force]", "error");
				return;
			}
			const exec = (cmd: string, a: string[], opts?: { cwd?: string }) => pi.exec(cmd, a, opts);
			try {
				const res = await restoreCheckpoint(exec, ctx.cwd, id, { force });
				if (res.error) {
					ctx.ui.notify(`restore: ${res.error}`, "error");
					return;
				}
				ctx.ui.notify(`restored checkpoint ${res.id}: ${res.restored.length} file(s)${res.conflicts.length > 0 ? ` | ${res.conflicts.length} conflicts skipped` : ""}`, "info");
			} catch (err) {
				ctx.ui.notify(`restore: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
