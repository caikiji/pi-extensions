/**
 * Read Unity project version from ProjectSettings/ProjectVersion.txt.
 *
 * File format (example):
 *   m_EditorVersion: 2021.3.15f1
 *   m_EditorVersionWithRevision: 2021.3.15f1 (xxx)
 *
 * The version string follows the pattern: YYYY.N.PfN (e.g. 2021.3.15f1)
 * or for Unity 6: 6000.x.y (e.g. 6000.0.2f1)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface UnityVersion {
	raw: string; // "2021.3.15f1"
	major: number; // 2021
	minor: number; // 3
	patch: number; // 15
	suffix: string; // "f1"
}

/**
 * Read ProjectVersion.txt and return the version string.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function readProjectVersion(projectPath: string): string | null {
	const versionFile = join(projectPath, "ProjectSettings", "ProjectVersion.txt");
	if (!existsSync(versionFile)) return null;

	try {
		const content = readFileSync(versionFile, "utf-8");
		// m_EditorVersion: 2021.3.15f1
		const match = content.match(/^m_EditorVersion:\s*(\S+)/m);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

/**
 * Parse a Unity version string into components.
 *   "2021.3.15f1" -> { major: 2021, minor: 3, patch: 15, suffix: "f1" }
 *   "6000.0.2f1"  -> { major: 6000, minor: 0, patch: 2, suffix: "f1" }
 *   "2019.4.0f1"  -> { major: 2019, minor: 4, patch: 0, suffix: "f1" }
 */
export function parseUnityVersion(version: string): UnityVersion | null {
	// Match: <major>.<minor>.<patch><suffix>
	// suffix is typically "f1" (final), "b1" (beta), "a1" (alpha)
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)([a-zA-Z]\d*)?$/);
	if (!match) return null;
	return {
		raw: version,
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		suffix: match[4] ?? "",
	};
}

/**
 * Compare two Unity versions.
 * Returns: -1 if a < b, 0 if equal, 1 if a > b.
 *
 * Suffix ordering: alpha (a) < beta (b) < final (f) < patch (p).
 * Within the same letter, higher number wins.
 */
export function compareUnityVersions(a: string, b: string): number {
	const va = parseUnityVersion(a);
	const vb = parseUnityVersion(b);
	if (!va || !vb) {
		// Fall back to string comparison if parsing fails
		return a < b ? -1 : a > b ? 1 : 0;
	}

	if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
	if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
	if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;

	// Compare suffixes: a < b < f < p
	const suffixRank = (s: string): number => {
		if (!s) return 4; // no suffix = final release, highest
		const letter = s[0].toLowerCase();
		const num = Number.parseInt(s.slice(1) || "0", 10);
		const rank = { a: 0, b: 1, f: 2, p: 3 }[letter] ?? 4;
		return rank * 1000 + num;
	};

	const ra = suffixRank(va.suffix);
	const rb = suffixRank(vb.suffix);
	return ra < rb ? -1 : ra > rb ? 1 : 0;
}

/**
 * Check if a project version meets a minimum requirement.
 */
export function isAtLeastVersion(projectVersion: string, minimum: string): boolean {
	return compareUnityVersions(projectVersion, minimum) >= 0;
}
