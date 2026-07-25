/**
 * Unity.exe path discovery, project root detection, and log path resolution.
 *
 * Path discovery chain (per research):
 *   1. UNITY_EDITOR_PATH env var (direct override)
 *   2. Unity Hub: %APPDATA%\UnityHub\secondaryInstallPath.json + ProjectVersion.txt
 *   3. Registry fallback (legacy standalone installs, Windows only)
 *
 * Log paths (2019.4 -> Unity 6 all default to project-level):
 *   - Project-level (default): <projectPath>/Logs/Editor.log
 *   - Global (only with -useGlobalLog): platform-specific
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readProjectVersion } from "./project-version.ts";

export interface UnityInstall {
	path: string; // absolute path to Unity executable
	version: string; // e.g. "2021.3.15f1"
	source: "env" | "hub" | "registry" | "fallback";
}

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
 * Discover the Unity.exe path for a given project.
 *
 * Resolution order:
 *   1. UNITY_EDITOR_PATH env var
 *   2. Unity Hub secondary install path + project version from ProjectVersion.txt
 *   3. Windows registry (legacy standalone installs)
 *
 * Returns null if no install can be found.
 */
export function discoverUnityInstall(projectPath: string): UnityInstall | null {
	// 1. Environment override
	const envPath = process.env.UNITY_EDITOR_PATH;
	if (envPath && existsSync(envPath)) {
		return {
			path: envPath,
			version: process.env.UNITY_EDITOR_VERSION ?? readProjectVersion(projectPath) ?? "unknown",
			source: "env",
		};
	}

	const projectVersion = readProjectVersion(projectPath);

	// 2. Unity Hub
	const hubInstall = discoverViaHub(projectVersion);
	if (hubInstall) return hubInstall;

	// 3. Registry (Windows only, legacy)
	if (platform() === "win32") {
		const regInstall = discoverViaRegistry(projectVersion);
		if (regInstall) return regInstall;
	}

	return null;
}

/**
 * Discover Unity via Unity Hub.
 *
 * Hub stores install roots in:
 *   Windows: %APPDATA%\UnityHub\secondaryInstallPath.json
 *   macOS:   ~/Library/Application Support/UnityHub/secondaryInstallPath.json
 *   Linux:   ~/.config/UnityHub/secondaryInstallPath.json
 *
 * The file contains a JSON-encoded string of the default install root.
 * Each version lives in <root>/<version>/Editor/<Unity|Unity.exe>.
 */
function discoverViaHub(projectVersion: string | null): UnityInstall | null {
	const hubConfigPath = getHubConfigPath();
	if (!hubConfigPath || !existsSync(hubConfigPath)) return null;

	let installRoot: string;
	try {
		const raw = readFileSync(hubConfigPath, "utf-8").trim();
		// secondaryInstallPath.json contains a JSON string (quoted), e.g. "D:\\Program Files\\Unity"
		installRoot = JSON.parse(raw);
		if (typeof installRoot !== "string" || !installRoot) return null;
	} catch {
		return null;
	}

	if (!existsSync(installRoot)) return null;

	// The project version is required to locate the install; without it, we
	// cannot pick a specific version directory.
	if (!projectVersion) return null;

	const exe = getUnityExecutablePath(installRoot, projectVersion);
	if (exe && existsSync(exe)) {
		return { path: exe, version: projectVersion, source: "hub" };
	}

	return null;
}

function getHubConfigPath(): string | null {
	const home = homedir();
	switch (platform()) {
		case "win32": {
			const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
			return join(appData, "UnityHub", "secondaryInstallPath.json");
		}
		case "darwin":
			return join(home, "Library", "Application Support", "UnityHub", "secondaryInstallPath.json");
		case "linux":
			return join(home, ".config", "UnityHub", "secondaryInstallPath.json");
		default:
			return null;
	}
}

/**
 * Build the Unity executable path for a given install root + version.
 *   Windows: <root>/<version>/Editor/Unity.exe
 *   macOS:   <root>/<version>/Unity.app/Contents/MacOS/Unity
 *   Linux:   <root>/<version>/Editor/Unity
 */
function getUnityExecutablePath(installRoot: string, version: string): string | null {
	const versionDir = join(installRoot, version);
	switch (platform()) {
		case "win32":
			return join(versionDir, "Editor", "Unity.exe");
		case "darwin":
			return join(versionDir, "Unity.app", "Contents", "MacOS", "Unity");
		case "linux":
			return join(versionDir, "Editor", "Unity");
		default:
			return null;
	}
}

/**
 * Discover Unity via Windows registry (legacy standalone installs).
 *
 * Key: HKCU\SOFTWARE\Unity Technologies\Installer\Unity
 * Value: "Location x64" = install dir containing Editor\Unity.exe
 *
 * Note: this only works for old standalone installs, not Hub-managed ones.
 */
function discoverViaRegistry(projectVersion: string | null): UnityInstall | null {
	// We avoid spawning reg.exe synchronously here for cross-platform safety.
	// This is a best-effort: check the common default install location.
	const defaultPaths = [
		"C:\\Program Files\\Unity\\Hub\\Editor",
		"C:\\Program Files\\Unity",
	];
	for (const base of defaultPaths) {
		if (!existsSync(base)) continue;
		if (projectVersion) {
			const exe = getUnityExecutablePath(base, projectVersion);
			if (exe && existsSync(exe)) {
				return { path: exe, version: projectVersion, source: "registry" };
			}
		}
	}
	return null;
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
