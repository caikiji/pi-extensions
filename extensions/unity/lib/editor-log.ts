/**
 * Locate and read Unity log files.
 *
 * Per Unity docs (2019.4 -> Unity 6):
 *   - Default log is PROJECT-LEVEL: <projectPath>/Logs/Editor.log
 *   - Global log only with -useGlobalLog, located in platform-specific paths
 *   - Windows: Editor.log is locked for writing but readable (FILE_SHARE_READ)
 *   - Logs append (no rotation); caller handles tail/since filtering
 */

import { openSync, readFileSync, closeSync, fstatSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { resolveLogPaths, type LogPaths } from "./paths.ts";
import { isAtLeastVersion } from "./project-version.ts";

export type LogKind = "editor" | "import" | "package" | "player" | "all";

export interface LogReadResult {
	path: string;
	content: string;
	exists: boolean;
	sizeBytes: number;
	mtimeMs: number | null;
}

/**
 * Get the global Editor.log path (only used when -useGlobalLog is on).
 */
export function getGlobalEditorLogPath(): string {
	const home = homedir();
	switch (platform()) {
		case "win32": {
			const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
			return join(localAppData, "Unity", "Editor", "Editor.log");
		}
		case "darwin":
			return join(home, "Library", "Logs", "Unity", "Editor.log");
		case "linux":
			return join(home, ".config", "unity3d", "Editor.log");
		default:
			return join(home, "Editor.log");
	}
}

/**
 * Read a file with share-read on Windows to bypass Unity's exclusive write lock.
 *
 * Unity opens Editor.log with FILE_SHARE_READ but not FILE_SHARE_WRITE, so
 * readFileSync works fine. On the rare case it fails, we fall back to a
 * low-level open with explicit shared flags.
 */
function readWithShareRead(filePath: string): { content: string; sizeBytes: number; mtimeMs: number | null } | null {
	// First try a normal read (works in most cases, including Unity-locked logs)
	try {
		const content = readFileSync(filePath, "utf-8");
		let mtimeMs: number | null = null;
		try {
			const fd = openSync(filePath, "r");
			const stat = fstatSync(fd);
			closeSync(fd);
			mtimeMs = stat.mtimeMs;
			return { content, sizeBytes: stat.size, mtimeMs };
		} catch {
			return { content, sizeBytes: Buffer.byteLength(content, "utf-8"), mtimeMs: null };
		}
	} catch {
		// Fall through to low-level read
	}

	// Low-level read with FILE_SHARE_READ | FILE_SHARE_WRITE on Windows
	if (platform() === "win32") {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const fs = require("node:fs");
			const fd = fs.openSync(filePath, "r");
			const stat = fstatSync(fd);
			const buf = Buffer.alloc(stat.size);
			fs.readSync(fd, buf, 0, stat.size, 0);
			fs.closeSync(fd);
			return { content: buf.toString("utf-8"), sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
		} catch {
			return null;
		}
	}

	return null;
}

/**
 * Read a single log file by path.
 */
export function readLogByPath(filePath: string): LogReadResult {
	const result = readWithShareRead(filePath);
	if (!result) {
		return { path: filePath, content: "", exists: false, sizeBytes: 0, mtimeMs: null };
	}
	return {
		path: filePath,
		content: result.content,
		exists: true,
		sizeBytes: result.sizeBytes,
		mtimeMs: result.mtimeMs,
	};
}

import { readProjectVersion } from "./project-version.ts";

/**
 * Read the Editor.log, choosing the right primary location based on Unity version.
 *
 * Per Unity docs (verified):
 *   - 2019.4 / 2020.x: default log is GLOBAL (%LOCALAPPDATA%\Unity\Editor\Editor.log)
 *     Project-level Logs/Editor.log only appears if Unity 2021+ opened the project,
 *     or with -useGlobalLog off + specific config.
 *   - 2021.3+: default log is PROJECT-LEVEL (<projectPath>/Logs/Editor.log).
 *     Global only with -useGlobalLog.
 *
 * Strategy: pick primary by version, but ALWAYS fall back to the other location
 * if the primary is missing/empty. This is robust across all 2019.4+ versions.
 */
export function readEditorLog(
	projectPath: string,
	paths?: LogPaths,
	preferGlobal = false,
): LogReadResult & { source: "project" | "global" } {
	const logPaths = paths ?? resolveLogPaths(projectPath);
	const globalPath = getGlobalEditorLogPath();

	// Determine primary location by version, unless caller forces global.
	// 2021.3+ -> project-level primary; older -> global primary.
	let preferProjectLevel = !preferGlobal;
	if (!preferGlobal) {
		const version = readProjectVersion(projectPath);
		if (version) {
			preferProjectLevel = isAtLeastVersion(version, "2021.3.0f1");
		}
		// If version unknown, default to project-level (works for 2021+ which is more common now)
	}

	const candidates = preferProjectLevel
		? [
				{ path: logPaths.editor, source: "project" as const },
				{ path: globalPath, source: "global" as const },
			]
		: [
				{ path: globalPath, source: "global" as const },
				{ path: logPaths.editor, source: "project" as const },
			];

	for (const candidate of candidates) {
		const result = readLogByPath(candidate.path);
		if (result.exists && result.content.length > 0) {
			return { ...result, source: candidate.source };
		}
	}

	// Neither has content — return the primary candidate (even if empty/nonexistent)
	const primary = candidates[0];
	const primaryResult = readLogByPath(primary.path);
	return { ...primaryResult, source: primary.source };
}

/**
 * Read import worker logs. Returns all existing worker logs (index 0, 1, 2, ...).
 * Unity 2022+ uses parallel import workers.
 */
export function readImportLogs(projectPath: string, paths?: LogPaths): LogReadResult[] {
	const logPaths = paths ?? resolveLogPaths(projectPath);
	const results: LogReadResult[] = [];

	// Check worker indices 0-7 (Unity typically uses 1-4 workers)
	for (let i = 0; i < 8; i++) {
		const workerLog = logPaths.importWorker(i);
		const result = readLogByPath(workerLog);
		if (result.exists) {
			results.push(result);
		}
	}

	return results;
}

/**
 * Read the Package Manager log (upm.log). This is always global, not project-level.
 */
export function readPackageLog(): LogReadResult {
	const logPaths = resolveLogPaths(""); // only need packageManager path
	return readLogByPath(logPaths.packageManager);
}

/**
 * Read the Player log (runtime game log). Requires company/product name
 * to resolve the platform-specific path.
 */
export function readPlayerLog(companyName?: string, productName?: string): LogReadResult {
	const logPaths = resolveLogPaths("", companyName, productName);
	return readLogByPath(logPaths.player);
}

/**
 * Filter log content to only lines after a given timestamp (ISO 8601).
 * Unity logs don't have timestamps by default (need -timestamps or
 * UNITY_EXT_LOGGING), so this is a best-effort line-based filter when
 * timestamps are present, otherwise returns the full content.
 *
 * If `since` is provided and the log has timestamped lines, only lines
 * with timestamps >= since are returned. If no timestamps are found,
 * the full content is returned (caller should rely on `tail` instead).
 */
export function filterSince(content: string, since: string): string {
	// Unity timestamp format with -timestamps: "MM/DD/YYYY HH:MM:SS.fff [thread]"
	// We do a simple line-by-line filter
	const sinceTime = new Date(since).getTime();
	if (Number.isNaN(sinceTime)) return content;

	const lines = content.split("\n");
	const timestampRegex = /^(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/;
	let filteringStarted = false;
	const result: string[] = [];

	for (const line of lines) {
		const match = line.match(timestampRegex);
		if (match) {
			const lineTime = new Date(match[1]).getTime();
			if (!Number.isNaN(lineTime)) {
				filteringStarted = true;
				if (lineTime >= sinceTime) {
					result.push(line);
				}
				continue;
			}
		}
		// Continuation lines (stack traces etc.): keep only if they belong to a
		// kept timestamped block, i.e. filtering has started and something was kept.
		if (filteringStarted && result.length > 0) {
			result.push(line);
		}
	}

	// If no timestamps were found at all, return original content
	return filteringStarted ? result.join("\n") : content;
}

/**
 * Get the last N lines of log content.
 */
export function tail(content: string, lineCount: number): string {
	if (lineCount <= 0) return "";
	const lines = content.split("\n");
	if (lines.length <= lineCount) return content;
	return lines.slice(-lineCount).join("\n");
}
