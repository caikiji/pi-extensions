/**
 * Project root detection, Unity lockfile handling, and log path resolution.
 *
 * Log paths (2019.4 -> Unity 6 all default to project-level):
 *   - Project-level (default): <projectPath>/Logs/Editor.log
 *   - Global (only with -useGlobalLog): platform-specific
 */

import { existsSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface LogPaths {
	editor: string; // <projectPath>/Logs/Editor.log
	importWorker: (index: number) => string; // Logs/AssetImportWorker{index}.log
	shaderCompiler: (index: number) => string; // Logs/shadercompiler-AssetImportWorker{index}.log
	player: string; // platform-specific Player.log
	packageManager: string; // platform-specific upm.log
	crashes: string; // crash reports dir
}

/**
 * Detect whether a path is inside a Unity project by looking for
 * ProjectSettings/ and Assets/ directories.
 */
export function findProjectRoot(startPath: string): string | null {
	let dir = resolve(startPath);
	const root = dirname(dir);

	// Walk up until we find ProjectSettings/ + Assets/, or hit filesystem root
	// eslint-disable-next-line no-constant-condition
	while (true) {
		if (existsSync(join(dir, "ProjectSettings")) && existsSync(join(dir, "Assets"))) {
			return dir;
		}
		if (dir === root) return null;
		dir = dirname(dir);
	}
}
/**
 * Resolve all relevant log paths for a Unity project.
 *
 * Per Unity docs (2019.4 -> Unity 6): default is project-level logs at
 * <projectPath>/Logs/Editor.log. Global logs only appear with -useGlobalLog.
 */
export function resolveLogPaths(projectPath: string, companyName?: string, productName?: string): LogPaths {
	const projectLogsDir = join(projectPath, "Logs");

	// Player log location is platform-specific
	const playerLog = getPlayerLogPath(companyName, productName);

	// Package manager log is always global (not project-level)
	const packageManagerLog = getUpmLogPath();

	// Crash reports
	const crashesDir = getCrashesDir(companyName, productName);

	return {
		editor: join(projectLogsDir, "Editor.log"),
		importWorker: (index: number) => join(projectLogsDir, `AssetImportWorker${index}.log`),
		shaderCompiler: (index: number) => join(projectLogsDir, `shadercompiler-AssetImportWorker${index}.log`),
		player: playerLog,
		packageManager: packageManagerLog,
		crashes: crashesDir,
	};
}

function getPlayerLogPath(companyName?: string, productName?: string): string {
	const home = homedir();
	// Player.log: %USERPROFILE%\AppData\LocalLow\<Company>\<Product>\Player.log (Windows)
	//            ~/Library/Logs/<Company>/<Product>/Player.log (macOS)
	//            ~/.config/unity3d/<Company>/<Product>/Player.log (Linux)
	const company = companyName ?? "DefaultCompany";
	const product = productName ?? "UnnamedProduct";
	switch (platform()) {
		case "win32": {
			const userProfile = process.env.USERPROFILE ?? home;
			return join(userProfile, "AppData", "LocalLow", company, product, "Player.log");
		}
		case "darwin":
			return join(home, "Library", "Logs", company, product, "Player.log");
		case "linux":
			return join(home, ".config", "unity3d", company, product, "Player.log");
		default:
			return join(tmpdir(), "Player.log");
	}
}

function getUpmLogPath(): string {
	const home = homedir();
	switch (platform()) {
		case "win32": {
			const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
			return join(localAppData, "Unity", "Editor", "upm.log");
		}
		case "darwin":
			return join(home, "Library", "Logs", "Unity", "upm.log");
		case "linux":
			return join(home, ".config", "unity3d", "upm.log");
		default:
			return join(tmpdir(), "upm.log");
	}
}

function getCrashesDir(companyName?: string, productName?: string): string {
	const company = companyName ?? "DefaultCompany";
	const product = productName ?? "UnnamedProduct";
	switch (platform()) {
		case "win32": {
			const tmp = process.env.TMP ?? process.env.TEMP ?? tmpdir();
			return join(tmp, "Unity", "Editor", "Crashes");
		}
		case "darwin":
			return join(homedir(), "Library", "Logs", "Unity", "Crashes");
		case "linux":
			return join(homedir(), ".config", "unity3d", "Crashes");
		default:
			return join(tmpdir(), "Unity", "Crashes");
	}
}

/**
 * Path to the Unity lockfile that indicates a running Unity instance.
 * Unity creates Temp/UnityLockfile on startup and holds an exclusive lock
 * until exit. On crash, the file remains and must be deleted manually.
 *
 * Note: Unity docs/community use both "UnityLockfile" and "UnityLockFile".
 * Empirically the canonical name is "UnityLockfile" (no capital F).
 */
export function getUnityLockfilePath(projectPath: string): string {
	return join(projectPath, "Temp", "UnityLockfile");
}

/**
 * Check if a file is locked by another process (Windows).
 * On non-Windows, returns false (POSIX advisory locks don't block reads).
 */
export function isFileLocked(filePath: string): boolean {
	if (platform() !== "win32") return false;
	try {
		// Try to open for writing (exclusive). If locked, this throws.
		// We use stat first to ensure existence.
		if (!existsSync(filePath)) return false;
		// On Windows, a locked file can still be stat'd but not opened for writing.
		// Use a write probe via fs.openSync with 'r+' flag.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs");
		const fd = fs.openSync(filePath, "r+");
		fs.closeSync(fd);
		return false;
	} catch (err: unknown) {
		// EBUSY / EPERM / EACCES on Windows indicates a lock
		const code = (err as NodeJS.ErrnoException)?.code;
		return code === "EBUSY" || code === "EPERM" || code === "EACCES";
	}
}
