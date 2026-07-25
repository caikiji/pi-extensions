/**
 * unity_status tool — detect Unity Editor state.
 *
 * Returns whether Unity is running, compiling, or importing for the project,
 * plus the project's Unity version. Uses Temp/UnityLockfile existence and
 * log tail keywords.
 */

import { existsSync } from "node:fs";
import { Type } from "typebox";
import { readEditorLog, tail } from "../lib/editor-log.ts";
import { getUnityLockfilePath, isFileLocked } from "../lib/paths.ts";
import { readProjectVersion } from "../lib/project-version.ts";
import { resolveProjectPath } from "../lib/tool-utils.ts";

export const unityStatusParams = Type.Object({
	projectPath: Type.Optional(
		Type.String({ description: "Path to Unity project root. Defaults to auto-detect from cwd." }),
	),
});

export type UnityStatusParams = { projectPath?: string };

export interface UnityStatusResult {
	projectPath: string;
	unityVersion: string | null;
	isRunning: boolean;
	isCompiling: boolean;
	isImporting: boolean;
	lockfileExists: boolean;
	lockfileLocked: boolean;
}

export async function runUnityStatus(params: UnityStatusParams, cwd: string): Promise<UnityStatusResult> {
	const projectPath = resolveProjectPath(params.projectPath, cwd);
	const lockfilePath = getUnityLockfilePath(projectPath);
	const lockfileExists = existsSync(lockfilePath);
	const lockfileLocked = lockfileExists && isFileLocked(lockfilePath);

	// Read version
	const unityVersion = readProjectVersion(projectPath);

	// Determine compiling/importing state from log tail
	let isCompiling = false;
	let isImporting = false;
	if (lockfileExists) {
		const logResult = readEditorLog(projectPath);
		if (logResult.exists) {
			const tailContent = tail(logResult.content, 200).toLowerCase();
			isCompiling =
				/compiling|compilation|begin assembly|finished assembly/i.test(tailContent) &&
				!/compilation finished|compilation succeeded/i.test(tailContent);
			isImporting = /importing|asset import|refresh.*asset/i.test(tailContent) &&
				!/import finished|refresh finished/i.test(tailContent);
		}
	}

	return {
		projectPath,
		unityVersion,
		isRunning: lockfileExists && lockfileLocked,
		isCompiling,
		isImporting,
		lockfileExists,
		lockfileLocked,
	};
}

