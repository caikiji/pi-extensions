/**
 * unity_project tool — read Unity project metadata.
 *
 * Returns: version, assemblies (from .asmdef), packages (from manifest.json),
 * scripting backend, and serialization settings. All read-only.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { Type } from "typebox";
import { resolveProjectPath } from "../lib/tool-utils.ts";
import { readProjectVersion } from "../lib/project-version.ts";

export const unityProjectParams = Type.Object({
	projectPath: Type.Optional(
		Type.String({ description: "Path to Unity project root. Defaults to auto-detect from cwd." }),
	),
});

export type UnityProjectParams = { projectPath?: string };

export interface AssemblyInfo {
	name: string;
	path: string; // relative to project root
	references: string[];
	defines: string[];
}

export interface PackageInfo {
	name: string;
	version: string;
	source: "registry" | "embedded" | "local" | "git";
}

export interface UnityProjectResult {
	projectPath: string;
	unityVersion: string | null;
	scriptingBackend: string | null;
	forceTextSerialization: boolean | null;
	assemblies: AssemblyInfo[];
	packages: PackageInfo[];
}

export async function runUnityProject(params: UnityProjectParams, cwd: string): Promise<UnityProjectResult> {
	const projectPath = resolveProjectPath(params.projectPath, cwd);

	const unityVersion = readProjectVersion(projectPath);
	const assemblies = collectAssemblies(projectPath);
	const packages = collectPackages(projectPath);
	const { scriptingBackend, forceTextSerialization } = readProjectSettings(projectPath);

	return {
		projectPath,
		unityVersion,
		scriptingBackend,
		forceTextSerialization,
		assemblies,
		packages,
	};
}

/**
 * Recursively find all .asmdef files under Assets/ and Packages/.
 */
function collectAssemblies(projectPath: string): AssemblyInfo[] {
	const assemblies: AssemblyInfo[] = [];
	const searchDirs = [join(projectPath, "Assets"), join(projectPath, "Packages")];

	for (const searchDir of searchDirs) {
		if (!existsSync(searchDir)) continue;
		const asmdefPaths = findFilesRecursive(searchDir, ".asmdef");
		for (const asmdefPath of asmdefPaths) {
			try {
				const content = readFileSync(asmdefPath, "utf-8");
				const parsed = JSON.parse(content) as {
					name?: string;
					references?: string[];
					defineConstraints?: string[];
					versionDefines?: unknown[];
				};
				assemblies.push({
					name: parsed.name ?? "(unnamed)",
					path: relative(projectPath, asmdefPath).replace(/\\/g, "/"),
					references: parsed.references ?? [],
					defines: parsed.defineConstraints ?? [],
				});
			} catch {
				// Skip malformed asmdef
			}
		}
	}

	return assemblies;
}

function findFilesRecursive(dir: string, extension: string): string[] {
	const results: string[] = [];
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }) as unknown as import("node:fs").Dirent[];
	} catch {
		return results;
	}

	for (const entry of entries) {
		// Skip Library, Temp, .git, obj, Bin
		if (["Library", "Temp", ".git", "obj", "Bin", "Logs"].includes(String(entry.name))) continue;

		const fullPath = join(dir, String(entry.name));
		if (entry.isDirectory()) {
			results.push(...findFilesRecursive(fullPath, extension));
		} else if (String(entry.name).endsWith(extension)) {
			results.push(fullPath);
		}
	}
	return results;
}

/**
 * Parse Packages/manifest.json for dependencies.
 */
function collectPackages(projectPath: string): PackageInfo[] {
	const manifestPath = join(projectPath, "Packages", "manifest.json");
	if (!existsSync(manifestPath)) return [];

	try {
		const content = readFileSync(manifestPath, "utf-8");
		const parsed = JSON.parse(content) as { dependencies?: Record<string, string> };
		const deps = parsed.dependencies ?? {};

		return Object.entries(deps).map(([name, version]) => {
			let source: PackageInfo["source"] = "registry";
			if (version.startsWith("file:")) source = "local";
			else if (version.startsWith("https://") || version.startsWith("git://") || version.includes("@")) {
				source = "git";
			} else if (/^\d+\.\d+\.\d+/.test(version)) {
				source = "registry";
			}
			// Embedded packages don't appear in dependencies (they're just folders in Packages/)
			return { name, version, source };
		});
	} catch {
		return [];
	}
}

/**
 * Read ProjectSettings for scripting backend and serialization mode.
 *
 * IMPORTANT: These live in TWO different files (verified against Unity source):
 *   - scriptingBackend: ProjectSettings/ProjectSettings.asset
 *     Format is PER-PLATFORM: `scriptingBackend:\n  Android: 1\n  Standalone: 0`
 *     Empty `{}` means all platforms use default (Mono on platforms that support it).
 *     Enum: 0 = Mono, 1 = IL2CPP, 2 = WinRT (deprecated)
 *   - m_SerializationMode: ProjectSettings/EditorSettings.asset (NOT ProjectSettings.asset!)
 *     Enum (from UnityCsReference EditorSettings.bindings.cs):
 *       0 = Mixed, 1 = ForceBinary, 2 = ForceText
 *     Missing file/field means Mixed (Unity's default).
 */
function readProjectSettings(projectPath: string): {
	scriptingBackend: string | null;
	forceTextSerialization: boolean | null;
} {
	const playerSettingsPath = join(projectPath, "ProjectSettings", "ProjectSettings.asset");
	const editorSettingsPath = join(projectPath, "ProjectSettings", "EditorSettings.asset");

	// --- scriptingBackend (from ProjectSettings.asset, per-platform) ---
	let scriptingBackend: string | null = null;
	if (existsSync(playerSettingsPath)) {
		try {
			const content = readFileSync(playerSettingsPath, "utf-8");
			// scriptingBackend may be:
			//   scriptingBackend: {}          -> empty, all default Mono
			//   scriptingBackend: 0           -> bare value (older format)
			//   scriptingBackend:
			//     Android: 1                  -> per-platform map
			//     Standalone: 0
			const backendSection = extractYamlBlock(content, "scriptingBackend");
			scriptingBackend = parseScriptingBackend(backendSection);
		} catch {
			// leave null
		}
	}

	// --- m_SerializationMode (from EditorSettings.asset) ---
	let forceTextSerialization: boolean | null = null;
	if (existsSync(editorSettingsPath)) {
		try {
			const content = readFileSync(editorSettingsPath, "utf-8");
			// m_SerializationMode: 0 = Mixed, 1 = ForceBinary, 2 = ForceText
			const serMatch = content.match(/m_SerializationMode:\s*(\d+)/);
			const serNum = serMatch ? Number.parseInt(serMatch[1], 10) : null;
			if (serNum !== null) {
				forceTextSerialization = serNum === 2;
			}
		} catch {
			// leave null
		}
	}

	return { scriptingBackend, forceTextSerialization };
}

/**
 * Extract a YAML field (key + its indented children or inline value).
 * Handles indented keys (ProjectSettings.asset is nested YAML, so fields like
 * `scriptingBackend` live under `PlayerSettings:` with leading whitespace).
 * Returns the inline value (e.g. "{}" or "0") or the multi-line indented block.
 */
function extractYamlBlock(content: string, key: string): string {
	// Match `key:` at any indentation, but ensure it's a real key (word boundary,
	// not a substring of another key like `scriptingBackendDefine`).
	const keyPattern = new RegExp(`^[ \t]*${key}:[ \t]*(.*)$`, "m");
	const match = content.match(keyPattern);
	if (!match) return "";

	const inlineValue = match[1]?.trim();
	if (inlineValue) return inlineValue; // e.g. "{}" or "0"

	// Multi-line: collect lines indented MORE than the key line
	const lines = content.split("\n");
	const keyLineIdx = lines.findIndex((l) => keyPattern.test(l));
	if (keyLineIdx === -1) return "";
	const keyIndent = (lines[keyLineIdx].match(/^[ \t]*/) ?? [""])[0].length;
	const blockLines: string[] = [];
	for (let i = keyLineIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") continue; // skip blank lines
		const indent = (line.match(/^[ \t]*/) ?? [""])[0].length;
		// Stop at a line indented <= keyIndent (next sibling or parent)
		if (indent <= keyIndent) break;
		blockLines.push(line);
	}
	return blockLines.join("\n");
}

/**
 * Parse a scriptingBackend block into a human-readable summary.
 * Returns "Mono" if empty/default, or "Platform: Backend, ..." for per-platform.
 */
function parseScriptingBackend(block: string): string {
	const trimmed = block.trim();
	if (!trimmed || trimmed === "{}") return "Mono"; // empty = all default Mono

	// Bare number (older format): scriptingBackend: 1
	const bareNum = trimmed.match(/^(\d+)$/);
	if (bareNum) {
		return backendName(Number.parseInt(bareNum[1], 10));
	}

	// Per-platform map: lines like "  Android: 1"
	// Use line-by-line split (matchAll with g flag has lastIndex pitfalls).
	// Note: don't trim the whole block — the first line's leading whitespace
	// matters for matching. Allow zero-or-more leading whitespace per line.
	const parts: string[] = [];
	for (const line of block.split("\n")) {
		const m = line.match(/^\s*(\S+):\s*(\d+)\s*$/);
		if (m) {
			parts.push(`${m[1]}: ${backendName(Number.parseInt(m[2], 10))}`);
		}
	}
	if (parts.length === 0) return "Mono"; // can't parse, assume default
	return parts.join(", ");
}

function backendName(num: number): string {
	switch (num) {
		case 0:
			return "Mono";
		case 1:
			return "IL2CPP";
		case 2:
			return "WinRT";
		default:
			return `Unknown(${num})`;
	}
}
