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
 *   - `git stash create` snapshots the working tree as a commit object without
 *     touching the worktree; the sha is kept alive via refs/pi-checkpoints/<id>.
 *   - Tracked files are restored with `git restore --source=<sha> --worktree`.
 *   - Untracked (new) files are copied into .git/pi-checkpoints/<id>/untracked/
 *     at snapshot time and copied back on restore.
 *   - Restore refuses (unless --force) any file whose current content differs
 *     from BOTH the snapshot and HEAD — that means you changed it too.
 *   - An automatic checkpoint is taken at every turn_start (ring of 20), so the
 *     agent always has a recent save point even without asking.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Absolute path of the git dir for cwd, or null if not a repo. Cached. */
const gitDirCache = new Map<string, string | null>();
async function getGitDir(exec: ExecFn, cwd: string): Promise<string | null> {
	const hit = gitDirCache.get(cwd);
	if (hit !== undefined) return hit;
	try {
		const res = await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd });
		const dir = res.code === 0 ? res.stdout.trim() : "";
		gitDirCache.set(cwd, dir || null);
		return dir || null;
	} catch {
		gitDirCache.set(cwd, null);
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
	rmSync(stateFileOf(gitDir), { force: true });
	writeFileSync(stateFileOf(gitDir), JSON.stringify(state, null, 2));
	rmSync(tmp, { force: true });
}

/** Hash of a file's content ("" if missing). Cheap conflict detection. */
async function fileHash(exec: ExecFn, cwd: string, path: string): Promise<string> {
	try {
		const res = await exec("git", ["hash-object", path], { cwd });
		return res.code === 0 ? res.stdout.trim() : "";
	} catch {
		return "";
	}
}

/** Blob hash of path inside a commit ("" if absent there). */
async function blobHash(exec: ExecFn, cwd: string, sha: string, path: string): Promise<string> {
	try {
		const res = await exec("git", ["rev-parse", `${sha}:${path}`], { cwd });
		return res.code === 0 ? res.stdout.trim() : "";
	} catch {
		return "";
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
	const gitDir = await getGitDir(exec, cwd);
	if (!gitDir) return null;

	// `git stash create` returns "" when the worktree is clean.
	const shaRes = await exec(
		"git",
		["-c", "user.name=pi", "-c", "user.email=pi@local", "stash", "create", msg || (auto ? "auto" : "checkpoint")],
		{ cwd },
	);
	if (shaRes.code !== 0) return null;
	const sha = shaRes.stdout.trim();
	if (!sha) return null;

	const id = makeId(auto);
	await execOk(exec, cwd, "git", ["update-ref", `refs/pi-checkpoints/${id}`, sha]);

	// Files changed vs HEAD (first parent of the stash commit).
	const diffRes = await execOk(exec, cwd, "git", ["diff-tree", "-r", "--name-only", "-z", `${sha}^`, sha]);
	const tracked = diffRes.stdout.split("\0").filter(Boolean);

	// Capture untracked files (new files the agent created).
	const untracked: string[] = [];
	const skipped: string[] = [];
	const untrackedRes = await execOk(exec, cwd, "git", ["ls-files", "--others", "--exclude-standard", "-z"]);
	const candidates = untrackedRes.stdout.split("\0").filter(Boolean);
	let totalBytes = 0;
	for (const rel of candidates) {
		if (untracked.length >= UNTRACKED_MAX_FILES) {
			skipped.push(rel);
			continue;
		}
		let st;
		try {
			st = statSync(join(cwd, rel));
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
		copyFileSync(join(cwd, rel), dest);
		totalBytes += st.size;
		untracked.push(rel);
	}

	const entry: CheckpointEntry = { id, msg: msg || (auto ? "auto" : "checkpoint"), ts: Date.now(), sha, tracked, untracked, skipped, auto };

	const state = loadState(gitDir);
	state.entries.push(entry);
	state.entries.sort((a, b) => b.ts - a.ts);

	// Prune: keep the newest AUTO_RING auto checkpoints, drop the rest.
	const autoEntries = state.entries.filter((e) => e.auto);
	const toDropAuto = autoEntries.slice(AUTO_RING);
	for (const e of toDropAuto) {
		await exec("git", ["update-ref", "-d", `refs/pi-checkpoints/${e.id}`], { cwd });
		rmSync(join(stateDirOf(gitDir), e.id), { recursive: true, force: true });
	}
	state.entries = state.entries.filter((e) => !toDropAuto.some((d) => d.id === e.id));

	// Manual entries are capped too (keep newest MANUAL_MAX).
	const manual = state.entries.filter((e) => !e.auto);
	const toDropManual = manual.slice(MANUAL_MAX);
	for (const e of toDropManual) {
		await exec("git", ["update-ref", "-d", `refs/pi-checkpoints/${e.id}`], { cwd });
		rmSync(join(stateDirOf(gitDir), e.id), { recursive: true, force: true });
	}
	state.entries = state.entries.filter((e) => !toDropManual.some((d) => d.id === e.id));

	saveState(gitDir, state);
	return entry;
}

export async function listCheckpoints(exec: ExecFn, cwd: string): Promise<CheckpointEntry[]> {
	const gitDir = await getGitDir(exec, cwd);
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
	const gitDir = await getGitDir(exec, cwd);
	if (!gitDir) return { ok: false, restored: [], conflicts: [], wouldDelete: [], error: "not a git repository" };

	const state = loadState(gitDir);
	let entry: CheckpointEntry | undefined;
	if (idOrLatest === "latest") entry = state.entries[0];
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

	// Tracked files: compare current vs HEAD vs snapshot hashes.
	for (const rel of entry.tracked) {
		const cur = await fileHash(exec, cwd, rel);
		const head = await blobHash(exec, cwd, "HEAD", rel);
		const snap = await blobHash(exec, cwd, entry.sha, rel);
		if (cur && cur !== head && cur !== snap) {
			if (!force) {
				conflicts.push(rel);
				continue;
			}
			// force: fall through and overwrite the conflicting file
		}
		if (!snap) {
			// Deleted in the snapshot: restoring means deleting it.
			if (cur) wouldDelete.push(rel);
			continue;
		}
		restoreable.push(rel);
	}

	// Untracked files: compare current vs stored copy.
	for (const rel of entry.untracked) {
		const stored = join(stateDirOf(gitDir), entry.id, "untracked", rel);
		if (!existsSync(stored)) continue;
		const cur = await fileHash(exec, cwd, rel);
		const snap = await fileHash(exec, cwd, stored);
		if (cur && cur !== snap) {
			if (!force) {
				conflicts.push(rel);
				continue;
			}
			// force: overwrite below
		}
		restored.push(rel);
	}

	if (conflicts.length > 0 && !force) {
		return {
			ok: false,
			restored: [],
			conflicts,
			wouldDelete,
			error: `${conflicts.length} file(s) changed since the checkpoint - use --force to overwrite them`,
		};
	}

	// Apply: tracked files from the snapshot commit.
	if (restoreable.length > 0) {
		await execOk(exec, cwd, "git", ["restore", "--source=" + entry.sha, "--worktree", "--", ...restoreable]);
	}
	restored.push(...restoreable);

	// Apply: untracked files from the stored copies.
	for (const rel of entry.untracked) {
		const stored = join(stateDirOf(gitDir), entry.id, "untracked", rel);
		if (!existsSync(stored)) continue;
		const dest = join(cwd, rel);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(stored, dest);
	}

	// Deleted-in-snapshot files: only remove with --force.
	if (wouldDelete.length > 0) {
		if (force) {
			for (const rel of wouldDelete) rmSync(join(cwd, rel), { force: true });
			restored.push(...wouldDelete.map((r) => `${r} (deleted)`));
			wouldDelete.length = 0;
		}
	}

	return { ok: true, restored, conflicts, wouldDelete };
}

export async function dropCheckpoint(exec: ExecFn, cwd: string, idOrAll: string): Promise<string[]> {
	const gitDir = await getGitDir(exec, cwd);
	if (!gitDir) return [];
	const state = loadState(gitDir);
	const targets = idOrAll === "all" ? state.entries : state.entries.filter((e) => e.id === idOrAll || e.id.startsWith(idOrAll));
	const dropped: string[] = [];
	for (const e of targets) {
		await exec("git", ["update-ref", "-d", `refs/pi-checkpoints/${e.id}`], { cwd });
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
		const files = e.tracked.length + e.untracked.length;
		const skip = e.skipped.length > 0 ? ` (+${e.skipped.length} skipped)` : "";
		let row = `${e.id}  ${fmtTs(e.ts)}  ${tag}${e.msg} | ${files} file${files === 1 ? "" : "s"}${skip}`;
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
}

interface RestoreParams {
	id: string;
	force?: boolean;
}

export default async function checkpointExtension(pi: ExtensionAPI): Promise<void> {
	let schema: object | undefined;
	let restoreSchema: object | undefined;
	try {
		const { Type } = await import("typebox");
		schema = Type.Object({ json: Type.Optional(Type.Boolean({ description: "Return machine-readable JSON" })) });
		restoreSchema = Type.Object({
			id: Type.String({ description: "Checkpoint id, id prefix, or 'latest'" }),
			force: Type.Optional(Type.Boolean({ description: "Overwrite files you changed after the checkpoint" })),
		});
	} catch {
		// typebox unavailable (plain-Node tests) — pi always has it
	}

	// Automatic save point before every agent turn (git repos only, silent).
	pi.on("turn_start", async (_event, ctx) => {
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
		parameters: (schema ?? {}) as never,
		async execute(_toolCallId, params: CheckpointParams, _signal, _onUpdate, ctx) {
			try {
				const entries = await listCheckpoints((cmd, args, opts) => pi.exec(cmd, args, opts), ctx.cwd);
				const text = params.json ? JSON.stringify(entries) : formatEntries(entries);
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
		parameters: (restoreSchema ?? {}) as never,
		async execute(_toolCallId, params: RestoreParams, _signal, _onUpdate, ctx) {
			try {
				const res = await restoreCheckpoint((cmd, args, opts) => pi.exec(cmd, args, opts), ctx.cwd, params.id, { force: params.force });
				const lines: string[] = [];
				if (res.error) lines.push(`error: ${res.error}`);
				if (res.restored.length > 0) lines.push(`restored ${res.restored.length} file(s)`);
				if (res.conflicts.length > 0) lines.push(`conflicts (not touched): ${res.conflicts.join(", ")}`);
				if (res.wouldDelete.length > 0) lines.push(`would delete (need --force): ${res.wouldDelete.join(", ")}`);
				return {
					content: [{ type: "text", text: lines.join("\n") || (res.ok ? "nothing to restore" : "restore failed") }],
					details: { ok: res.ok, restored: res.restored, conflicts: res.conflicts },
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
		handler: async (args: string, ctx) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const exec = (cmd: string, a: string[], opts?: { cwd?: string }) => pi.exec(cmd, a, opts);
			try {
				if (argv.length === 0 || argv[0] === "list") {
					const entries = await listCheckpoints(exec, ctx.cwd);
					ctx.ui.notify(formatEntries(entries, argv.includes("--full") || argv[0] === "list" && argv.includes("--full")), "info");
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
				ctx.ui.notify(`restored ${res.restored.length} file(s)${res.conflicts.length > 0 ? ` | ${res.conflicts.length} conflicts skipped` : ""}`, "info");
			} catch (err) {
				ctx.ui.notify(`restore: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
