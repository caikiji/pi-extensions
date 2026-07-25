/**
 * Shared helpers for unity tools.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { findProjectRoot } from "./paths.ts";

/**
 * Resolve a project path: use the provided path, or detect from cwd.
 * Throws if no Unity project can be found.
 */
export function resolveProjectPath(projectPath: string | undefined, cwd: string): string {
	const startPath = projectPath ? resolve(cwd, projectPath) : cwd;

	// If the given path is already a project root, use it directly
	if (existsSync(join(startPath, "ProjectSettings")) && existsSync(join(startPath, "Assets"))) {
		return startPath;
	}

	// Otherwise, search upward for a project root
	const root = findProjectRoot(startPath);
	if (!root) {
		throw new Error(
			`No Unity project found at or above: ${startPath}\n` +
				"A Unity project must contain both ProjectSettings/ and Assets/ directories.",
		);
	}
	return root;
}
