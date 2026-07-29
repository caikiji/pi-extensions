/**
 * unity_command tool — execute a command in a RUNNING Unity Editor via PiBridge.
 *
 * Unlike launching a separate Unity process, this tool talks to a PiBridge HTTP
 * server running INSIDE the open Editor instance. No second Unity process,
 * no cold-start delay.
 *
 * Requires PiBridge.cs to be placed in the project's Assets/Editor/ folder.
 * The bridge auto-starts when Unity loads the project and writes its port to
 * Temp/pi-bridge-port.
 *
 * Commands (see PiBridge.cs for full list):
 *   ping        — health check, returns bridge/Unity/project info (incl. autoFocus state)
 *   config      — query or change bridge settings (args: { autoFocus?: boolean })
 *   refresh     — AssetDatabase.Refresh()
 *   compile     — trigger recompilation
 *   status      — isCompiling / isPlaying / isUpdating etc.
 *   run-menu    — execute a menu item (args: { menuPath }). WARNING: ExecuteMenuItem is blocking; if it
 *                 opens a modal dialog, Unity's main thread freezes and the bridge becomes unresponsive
 *                 until the dialog is closed. run-menu uses a 15s timeout (default) and refuses to run
 *                 if a modal dialog is already open.
 *   asset-info  — load asset metadata (args: { path })
 *   log         — read recent Console entries (args: { count, severity })
 *                 severity filter: "error" (includes assert/exception), "warning", "log", or "" for all
 *   eval        — compile + run an arbitrary C# snippet on the main thread (args: { code }) via Roslyn.
 *                 Full Unity API access, multi-statement, LINQ, loops, `new GameObject()`, etc.
 *                 Compile errors come back with line/col diagnostics; return value is bounded-serialized
 *                 (primitives/strings/Vector3 as-is, complex objects as {type, toString}).
 *                 Enabled by default (localhost-only bridge; no extra opt-in).
 *                 v1 limit: avoid `await` in scripts — it can deadlock the main thread (see RoslynEval.cs).
 *
 * Background focus: when Unity is unfocused, EditorApplication.delayCall is throttled to ~1Hz, so the
 * bridge brings Unity to the foreground before dispatching (Windows only, bypasses the throttle).
 * Disable via `config { autoFocus: false }` if you don't want the window stealing focus.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { discoverBridge, sendCommand, waitForBridge, type BridgeInfo, type BridgeResponse } from "../lib/bridge-client.ts";
import { resolveProjectPath } from "../lib/tool-utils.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const BRIDGE_COMMANDS = [
	"ping",
	"config",
	"refresh",
	"compile",
	"status",
	"play",
	"run-menu",
	"asset-info",
	"log",
	"eval",
] as const;

export const unityCommandParams = Type.Object({
	command: StringEnum(BRIDGE_COMMANDS),
	projectPath: Type.Optional(
		Type.String({ description: "Path to Unity project root. Defaults to auto-detect from cwd." }),
	),
	args: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
			"Command arguments as JSON object. run-menu: { menuPath: 'File/Save' }. play: { mode: 'enter'|'exit'|'pause'|'resume' }. asset-info: { path: 'Assets/Foo.prefab' }. log: { count: 50 }. eval: { code: 'Mathf.Sqrt(16)' or a multi-statement C# block; the last expression is the return value; avoid await.' }.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in seconds (default 60). The Editor may be throttled when unfocused, causing second-level latency.",
			minimum: 5,
		}),
	),
});

export interface UnityCommandParams {
	command: (typeof BRIDGE_COMMANDS)[number];
	projectPath?: string;
	args?: Record<string, unknown>;
	timeout?: number;
}

export interface UnityCommandResult {
	projectPath: string;
	command: string;
	bridge: BridgeInfo;
	response: BridgeResponse;
}

export async function runUnityCommand(
	params: UnityCommandParams,
	cwd: string,
	signal?: AbortSignal,
): Promise<UnityCommandResult> {
	const projectPath = resolveProjectPath(params.projectPath, cwd);

	// 1. Discover the bridge (reads port file, falls back to probing)
	let bridge = await discoverBridge(projectPath);

	// 1b. If the bridge isn't up BUT the port file exists, the bridge was recently
	//   online — most likely a domain reload is in progress (e.g. a preceding
	//   install/compile/refresh triggered a recompile that's tearing the old
	//   bridge down and starting a new one). Rather than failing immediately and
	//   forcing the agent to retry, wait briefly for the bridge to come back.
	//   If there's no port file at all, Unity isn't open / bridge never installed —
	//   fail fast with the original helpful message.
	if (!bridge.available) {
		const portFile = join(projectPath, "Temp", "pi-bridge-port");
		if (existsSync(portFile)) {
			const waited = await waitForBridge(projectPath, {
				timeoutMs: 25000,
				signal,
			});
			bridge = waited.bridge;
		}
	}

	if (!bridge.available) {
		return {
			projectPath,
			command: params.command,
			bridge,
			response: {
				ok: false,
				error:
					bridge.reason ??
					"PiBridge is not running. Place PiBridge.cs in Assets/Editor/ of your Unity project and make sure Unity is open.",
				durationMs: 0,
			},
		};
	}

	// 2. Send the command.
	// run-menu gets a shorter default timeout (15s) because ExecuteMenuItem can
	// open a modal dialog and freeze Unity's main thread — after which the bridge
	// cannot respond at all. A long timeout there just delays the inevitable failure.
	let timeoutMs: number;
	if (params.command === "run-menu") {
		timeoutMs = (params.timeout ?? 15) * 1000;
	} else {
		timeoutMs = (params.timeout ?? 60) * 1000;
	}
	const response = await sendCommand(bridge.port!, params.command, params.args ?? {}, timeoutMs, signal);

	// 3. If run-menu timed out (not user-cancelled), annotate the error so the
	// AI knows the bridge may now be unresponsive (main thread frozen by a modal).
	if (!response.ok && params.command === "run-menu" && response.error && response.error.includes("Timed out")) {
		response.error =
			response.error +
			"\n\n⚠ run-menu timed out. ExecuteMenuItem likely opened a modal dialog and froze Unity's main thread. " +
			"The bridge may now be unresponsive until the dialog is closed in the Unity Editor. " +
			"Verify with unity_command ping before retrying.";
	}

	return {
		projectPath,
		command: params.command,
		bridge,
		response,
	};
}
