/**
 * unity_status tool — detect Unity Editor state.
 *
 * Returns whether Unity is running, compiling, or importing for the project,
 * plus the project's Unity version.
 *
 * Compiling/Importing prefer the bridge's authoritative
 * EditorApplication.isCompiling / isUpdating (via PiBridge /status) when
 * PiBridge is running. When the bridge is offline, it falls back to lockfile
 * existence + Editor.log tail keywords — a heuristic that can false-positive
 * (e.g. stale "compiling" lines in the tail), hence the bridge preference.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { discoverBridge, sendCommand, PORT_FILE } from "../lib/bridge-client.ts";
import { readEditorLog } from "../lib/editor-log.ts";
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
	/** Where isCompiling/isImporting came from: "bridge" = authoritative, "heuristic" = log-tail guess, "none" = Unity not running. */
	statusSource: "bridge" | "heuristic" | "none";
}

interface BridgeStatus {
	isCompiling: boolean;
	isPlaying: boolean;
	isPlayingOrWillChangePlaymode: boolean;
	isUpdating: boolean;
	timeSinceStartup: number;
}

/**
 * Best-effort compile/import state from the Editor.log tail.
 * Brittle (keyword-based, can false-positive on stale tail lines) — used only
 * when the bridge is unavailable.
 */
function heuristicCompileImport(logContent: string): { isCompiling: boolean; isImporting: boolean } {
	const tail = logContent.toLowerCase();
	const isCompiling =
		/compiling|compilation|begin assembly|finished assembly/i.test(tail) &&
		!/compilation finished|compilation succeeded/i.test(tail);
	const isImporting =
		/importing|asset import|refresh.*asset/i.test(tail) && !/import finished|refresh finished/i.test(tail);
	return { isCompiling, isImporting };
}

function heuristicFromLog(
	projectPath: string,
): { isCompiling: boolean; isImporting: boolean } {
	const logResult = readEditorLog(projectPath);
	return heuristicCompileImport(logResult.exists ? logResult.content : "");
}

export async function runUnityStatus(params: UnityStatusParams, cwd: string): Promise<UnityStatusResult> {
	const projectPath = resolveProjectPath(params.projectPath, cwd);
	const lockfilePath = getUnityLockfilePath(projectPath);
	const lockfileExists = existsSync(lockfilePath);
	const lockfileLocked = lockfileExists && isFileLocked(lockfilePath);
	const unityVersion = readProjectVersion(projectPath);

	let isRunning = lockfileExists && lockfileLocked;
	let isCompiling = false;
	let isImporting = false;
	let statusSource: UnityStatusResult["statusSource"] = "none";

	// Prefer the bridge's authoritative values. Only probe when a port file is
	// present (bridge installed) AND Unity looks running — avoids 20-port
	// probing latency when PiBridge clearly isn't set up.
	const portFile = join(projectPath, "Temp", PORT_FILE);
	if (lockfileExists && existsSync(portFile)) {
		const bridge = await discoverBridge(projectPath);
		if (bridge.available) {
			// Bridge up ⇒ Unity is running (also corrects non-Windows, where the
			// lockfile probe is a no-op and would otherwise report not-running).
			isRunning = true;
			const resp = await sendCommand<BridgeStatus>(bridge.port!, "status", {}, 5000);
			if (resp.ok && resp.result) {
				isCompiling = Boolean(resp.result.isCompiling);
				isImporting = Boolean(resp.result.isUpdating);
				statusSource = "bridge";
			} else {
				({ isCompiling, isImporting } = heuristicFromLog(projectPath));
				statusSource = "heuristic";
			}
		}
	}

	if (statusSource === "none" && isRunning) {
		({ isCompiling, isImporting } = heuristicFromLog(projectPath));
		statusSource = "heuristic";
	}

	return {
		projectPath,
		unityVersion,
		isRunning,
		isCompiling,
		isImporting,
		lockfileExists,
		lockfileLocked,
		statusSource,
	};
}
