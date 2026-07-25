/**
 * unity_run tool — execute a Unity Editor method via batchmode.
 *
 * The method must be a static, parameterless method in an Editor assembly:
 *
 *   // Assets/Editor/MyBuildTools.cs
 *   public static class MyBuildTools {
 *       public static void BuildAndroid() {
 *           // ... do work ...
 *           File.WriteAllText("Temp/pi-result.json",
 *               JsonUtility.ToJson(new { ok = true, path = "Build/Android/" }));
 *       }
 *   }
 *
 * Call: unity_run({ method: "MyBuildTools.BuildAndroid" })
 *
 * Results are triple-verified (exit code + log errors + result JSON) because
 * Unity exit codes are unreliable.
 */

import { Type } from "typebox";
import { runBatchmode, type BatchmodeResult, type ProgressCallback } from "../lib/batchmode.ts";
import { resolveProjectPath } from "../lib/tool-utils.ts";

export const unityRunParams = Type.Object({
	method: Type.String({
		description:
			"Fully-qualified static method name: Namespace.Class.Method. The method must be static, parameterless, and in an Editor assembly.",
	}),
	projectPath: Type.Optional(
		Type.String({ description: "Path to Unity project root. Defaults to auto-detect from cwd." }),
	),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Extra command-line arguments passed to Unity. Read inside the script via Environment.GetCommandLineArgs().",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Maximum execution time in seconds (default 600). Unity is force-killed after this.",
			minimum: 30,
		}),
	),
	extraArgs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Extra Unity CLI flags (e.g. ['-buildTarget', 'Android']).",
		}),
	),
	resultFile: Type.Optional(
		Type.String({
			description: "Path to a JSON file the script writes with results. Defaults to Temp/pi-result.json. The tool parses and returns it.",
		}),
	),
	unityPath: Type.Optional(
		Type.String({ description: "Override path to Unity executable. By default, discovered via UNITY_EDITOR_PATH env, Unity Hub, or registry." }),
	),
});

export interface UnityRunParams {
	method: string;
	projectPath?: string;
	args?: string[];
	timeout?: number;
	extraArgs?: string[];
	resultFile?: string;
	unityPath?: string;
}

export interface UnityRunResult extends BatchmodeResult {
	projectPath: string;
	method: string;
}

export async function runUnityRun(
	params: UnityRunParams,
	cwd: string,
	onUpdate: ProgressCallback | undefined,
	signal: AbortSignal | undefined,
): Promise<UnityRunResult> {
	const projectPath = resolveProjectPath(params.projectPath, cwd);

	const result = await runBatchmode({
		projectPath,
		method: params.method,
		args: params.args,
		timeout: params.timeout,
		extraArgs: params.extraArgs,
		resultFile: params.resultFile,
		unityPath: params.unityPath,
		onUpdate,
		signal,
	});

	return {
		...result,
		projectPath,
		method: params.method,
	};
}
