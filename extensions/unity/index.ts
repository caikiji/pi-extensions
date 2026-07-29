/**
 * Unity Editor integration extension for pi.
 *
 * Lets the AI coding agent:
 *   - Read Unity logs (compile errors, exceptions, import errors)
 *   - Detect Unity running/compiling/importing state
 *   - Read project metadata (version, assemblies, packages)
 *   - Drive a running Unity Editor via an in-Editor HTTP bridge (PiBridge)
 *
 * Supports Unity 2019.4 LTS and later (2020.3 / 2021.3 / 2022.3 / Unity 6).
 *
 * See README.md for full design and the result-passing convention.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runUnityCommand, unityCommandParams, type UnityCommandResult } from "./tools/unity-command.ts";
import { runUnityEvents, unityEventsParams, type UnityEventsResult } from "./tools/unity-events.ts";
import { runUnityInstallBridge, unityInstallBridgeParams, type UnityInstallBridgeResult } from "./tools/unity-install-bridge.ts";
import { runUnityLog, unityLogParams, type UnityLogResult } from "./tools/unity-log.ts";
import { runUnityProject, unityProjectParams, type UnityProjectResult } from "./tools/unity-project.ts";
import { runUnityStatus, unityStatusParams, type UnityStatusResult } from "./tools/unity-status.ts";

export default function (pi: ExtensionAPI) {
	// ─── custom TUI rendering for Unity event notifications ───────────────
	// Unity events arrive as custom messages (customType: "unity-event") so they
	// can be visually distinguished from user-typed messages in the transcript.
	// They still participate in LLM context (the agent sees them), but render
	// with a dim "[unity]" prefix instead of looking like the user typed them.
	pi.registerMessageRenderer("unity-event", (message, _options, theme) => {
		const ev = message.details as { event?: string; data?: string } | undefined;
		const name = ev?.event ?? "event";
		const data = ev?.data && ev.data !== "{}" ? ` ${ev.data}` : "";
		return new Text(theme.fg("dim", `[unity] ${name}${data}`), 0, 0);
	});

	pi.registerTool({
		name: "unity_log",
		label: "Unity Log",
		description:
			"Read and parse Unity Editor log files. Extracts compile errors (CSxxxx), runtime exceptions, asset import errors, and package manager errors as structured entries. " +
			"Use this to see what Unity is doing or diagnose build/compile failures. " +
			"By default reads the project-level Editor.log (Logs/Editor.log).",
		promptSnippet: "Read Unity Editor logs (compile errors, exceptions, import errors)",
		promptGuidelines: [
			"Use unity_log to diagnose Unity compile/runtime errors instead of manually grepping log files. It returns structured error entries with file/line/code.",
		],
		parameters: unityLogParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runUnityLog(params, ctx.cwd);
			return {
				content: [{ type: "text", text: formatUnityLogResult(result) }],
				details: result,
			};
		},

		renderResult(result, _options, theme) {
			const details = result.details as UnityLogResult | undefined;
			if (!details) {
				return new Text(theme.fg("dim", "(no log data)"), 0, 0);
			}
			const total = details.summary.total;
			const errors = details.summary.bySeverity.error ?? 0;
			const fatals = details.summary.bySeverity.fatal ?? 0;
			const color = total === 0 ? "success" : errors + fatals > 0 ? "error" : "warning";
			return new Text(
				theme.fg(color, `${total} entries`) +
					theme.fg("dim", ` (${errors} errors, ${fatals} fatal) from ${details.sources.length} log source(s)`),
				0,
				0,
			);
		},
	});

	// ─── unity_status ───────────────────────────────────────────────────────
	pi.registerTool({
		name: "unity_status",
		label: "Unity Status",
		description:
			"Check whether Unity Editor is currently running, compiling, or importing assets for a project. " +
			"Also returns the project's Unity version. Uses Temp/UnityLockfile to detect a running instance.",
		promptSnippet: "Check if Unity is running/compiling/importing",
		promptGuidelines: [
		"Use unity_status before starting a long Unity operation to avoid conflicts with an already-running Editor instance.",
		],
		parameters: unityStatusParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runUnityStatus(params, ctx.cwd);
			return {
				content: [{ type: "text", text: formatUnityStatusResult(result) }],
				details: result,
			};
		},

		renderResult(result, _options, theme) {
			const details = result.details as UnityStatusResult | undefined;
			if (!details) return new Text(theme.fg("dim", "(no status)"), 0, 0);
			const running = details.isRunning ? theme.fg("success", "● running") : theme.fg("dim", "○ idle");
			const version = details.unityVersion ? theme.fg("accent", details.unityVersion) : theme.fg("dim", "unknown version");
			// Flag Compiling/Importing values that came from the flaky log-tail heuristic,
			// not the authoritative bridge.
			const est = details.statusSource === "heuristic" ? theme.fg("warning", " (est.)") : "";
			return new Text(`${running} ${version}${est}`, 0, 0);
		},
	});

	// ─── unity_project ──────────────────────────────────────────────────────
	pi.registerTool({
		name: "unity_project",
		label: "Unity Project",
		description:
			"Read Unity project metadata: version (from ProjectVersion.txt), assemblies (all .asmdef files), packages (manifest.json), scripting backend, and serialization mode. Read-only.",
		promptSnippet: "Read Unity project metadata (version, assemblies, packages)",
		promptGuidelines: [
			"Use unity_project to understand a Unity project's structure before making changes. Returns asmdef references and package dependencies.",
		],
		parameters: unityProjectParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runUnityProject(params, ctx.cwd);
			return {
				content: [{ type: "text", text: formatUnityProjectResult(result) }],
				details: result,
			};
		},

		renderResult(result, _options, theme) {
			const details = result.details as UnityProjectResult | undefined;
			if (!details) return new Text(theme.fg("dim", "(no project data)"), 0, 0);
			return new Text(
				theme.fg("accent", details.unityVersion ?? "unknown") +
					theme.fg("dim", ` · ${details.assemblies.length} asmdef · ${details.packages.length} packages`),
				0,
				0,
			);
		},
	});

	// ─── unity_command ───────────────────────────────────────────────────────
	// Talks to a PiBridge HTTP server running INSIDE an already-open Unity
	// Editor instance. Avoids launching a second Unity process. Requires
	// PiBridge.cs in Assets/Editor/.
	pi.registerTool({
		name: "unity_command",
		label: "Unity Command",
		description:
			"Execute a command in a RUNNING Unity Editor instance via PiBridge (an HTTP bridge inside the Editor). " +
			"Requires PiBridge.cs in the project's Assets/Editor/ folder. " +
			"Commands: ping (health check), refresh (AssetDatabase.Refresh), compile (trigger recompile), " +
			"status (isCompiling/isPlaying/isUpdating), play (control Play Mode: enter/exit/pause/resume — may trigger domain reload that restarts the bridge; poll status afterwards), " +
			"run-menu (execute a menu item — RISKY: can open a modal dialog that freezes Unity's main thread and makes the bridge unresponsive; 15s timeout, refuses if a dialog is already open), asset-info (load asset metadata), " +
			"log (read recent Console entries), eval (Roslyn-compiled C# snippet on the main thread — arbitrary expressions/statements with full Unity API access; compile errors return line/col diagnostics; enabled by default, no opt-in needed). " +
			"This does NOT launch a new Unity process — it drives the already-open Editor via HTTP.",
		promptSnippet: "Run a command in the open Unity Editor via PiBridge HTTP bridge",
		promptGuidelines: [
			"Use unity_command when Unity is already open for the project — it drives the running instance via HTTP.",
			"Before unity_command, the PiBridge.cs file must be in Assets/Editor/. If unity_command reports 'PiBridge is not running', use unity_install_bridge to install it, then tell the user to focus Unity so it recompiles.",
			"After unity_command with 'compile' or 'refresh', poll unity_command status (or unity_status) until isCompiling becomes false — the Editor throttles when unfocused, so completion is not instant.",
			"After unity_command play (enter/exit), poll status until isPlaying matches the requested mode — EnterPlaymode/ExitPlaymode are async. Domain reload during the transition restarts the bridge; if a follow-up command fails, retry once status settles.",
			"unity_command run-menu is risky: ExecuteMenuItem is blocking and can open a modal dialog that freezes Unity's main thread, making the bridge unresponsive. Prefer dedicated commands (refresh/compile/status) over run-menu. If run-menu times out, tell the user a dialog may be open in Unity and they should close it, then verify with ping.",
			"unity_command eval (command=eval, args={code}) runs an arbitrary C# snippet compiled by Roslyn on the main thread. Write plain C# — the LAST expression is the return value (e.g. 'Mathf.Sqrt(16)' or a multi-line block ending in an expression). Avoid `await` in eval scripts (v1): it can deadlock the main thread when a continuation needs to resume there. Return values are bounded-serialized: primitives/strings/Vector3 pass through, complex Unity objects come back as {type, toString}. If eval returns 'Roslyn eval is unavailable', run unity_install_bridge to provision the matching Roslyn DLLs, then retry.",
		],
		parameters: unityCommandParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runUnityCommand(params, ctx.cwd, signal);
			return {
				content: [{ type: "text", text: formatUnityCommandResult(result) }],
				details: result,
			};
		},

		renderResult(result, _options, theme) {
			const details = result.details as UnityCommandResult | undefined;
			if (!details) return new Text(theme.fg("dim", "(no result)"), 0, 0);
			if (!details.bridge.available) {
				return new Text(theme.fg("warning", "⚠ bridge offline"), 0, 0);
			}
			const ok = details.response.ok;
			const status = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
			const duration = `${details.response.durationMs}ms`;
			return new Text(`${status} ${theme.fg("accent", details.command)} ${theme.fg("dim", duration)}`, 0, 0);
		},
	});

	// ─── unity_events ───────────────────────────────────────────────────────
	// Non-blocking event subscriptions. The agent subscribes, then keeps
	// working. When Unity fires a subscribed event (compile done, play mode
	// changed), PiBridge pushes it over an SSE stream and this tool's
	// background loop injects it via pi.sendMessage (customType "unity-event")
	// is the pi-unique capability MCP cannot replicate.
	pi.registerTool({
		name: "unity_events",
		label: "Unity Events",
		description:
			"Subscribe to Unity events (compile_started/compile_done, playmode_entered/playmode_exited) and get notified non-blocking. " +
			"Events fire inside Unity and are pushed to the agent via a background SSE stream + pi.sendMessage (customType \"unity-event\") — no polling, no waiting. " +
			"Requires PiBridge v0.6.0+. Use action=subscribe with events=[...] to start receiving notifications, action=list to see current subscriptions, action=unsubscribe to stop specific events.",
		promptSnippet: "Subscribe to Unity events (compile/playmode) — non-blocking, pushed via SSE",
		promptGuidelines: [
			"Use unity_events (action=subscribe) BEFORE triggering a long Unity operation (compile, play mode) so you get notified when it finishes instead of polling unity_command status.",
			"After subscribe, continue working — events arrive as follow-up user messages (deliverAs: followUp). compile_done data includes {errors:N}; if errors>0, follow up with unity_log to diagnose.",
			"Events are best-effort across domain reload: Unity recompiling/reloading clears the queue and may change the bridge port; the SSE loop auto-reconnects and re-discovers the port, but events that fire during the reload window are lost. Re-subscribe if needed after a reload.",
			"unsubscribe only removes the server-side filter; it does not stop the background SSE loop (cheap to leave running). Subscribe to the events you need rather than all of them.",
		],
		parameters: unityEventsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runUnityEvents(params as UnityEventsParams, ctx.cwd, pi);
			return {
				content: [{ type: "text", text: formatUnityEventsResult(result) }],
				details: result,
			};
		},

		renderResult(result, _options, theme) {
			const details = result.details as UnityEventsResult | undefined;
			if (!details) return new Text(theme.fg("dim", "(no result)"), 0, 0);
			if (!details.bridge.available) return new Text(theme.fg("warning", "⚠ bridge offline"), 0, 0);
			const ok = details.response.ok;
			const status = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
			const loop = details.sseLoop === "running" ? theme.fg("accent", " (sse started)") : details.sseLoop === "reused" ? theme.fg("dim", " (sse reused)") : "";
			return new Text(`${status} ${theme.fg("accent", details.bridge.url ?? "")}${loop}`, 0, 0);
		},
	});

	// ─── unity_install_bridge ───────────────────────────────────────────────
	// Auto-installs PiBridge.cs into a Unity project so unity_command works.
	// The AI can set up the bridge for any project given just the path.
	pi.registerTool({
		name: "unity_install_bridge",
		label: "Install PiBridge",
		description:
			"Install PiBridge into a Unity project so unity_command can drive its running Editor. " +
			"Copies the bundled PiBridge/*.cs files to <projectPath>/Assets/Editor/. " +
			"Creates Assets/Editor/ if missing and overwrites any existing bridge files. " +
			"After install, Unity auto-compiles on focus and the bridge starts — then unity_command becomes usable. " +
			"Use this BEFORE unity_command when the bridge is not yet installed in a project.",
		promptSnippet: "Install PiBridge into a Unity project (enables unity_command)",
		promptGuidelines: [
			"Use unity_install_bridge to set up PiBridge for a project before using unity_command. It writes the PiBridge/*.cs files to Assets/Editor/, overwriting any existing versions.",
			"If unity_command reports a version mismatch (PiBridge outdated), call unity_install_bridge again to update PiBridge — the extension and the C# bridge are versioned together.",
			"If any unity_command call fails unexpectedly (timeout, connection error, unknown command, malformed response), try unity_install_bridge to reinstall PiBridge — a stale or corrupted bridge is the most common cause, and reinstalling fixes it without touching the rest of the project.",
			"After unity_install_bridge, tell the user to focus the Unity window (or reopen the project) so it recompiles and starts the bridge. Then verify with unity_command ping.",
		],
		parameters: unityInstallBridgeParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await runUnityInstallBridge(params);
			return {
				content: [{ type: "text", text: formatInstallBridgeResult(result) }],
				details: result,
			};
		},

		renderResult(result, _options, theme) {
			const details = result.details as UnityInstallBridgeResult | undefined;
			if (!details) return new Text(theme.fg("dim", "(no result)"), 0, 0);
			return new Text(
				theme.fg("success", `✓ installed `) + theme.fg("accent", `v${details.version}`) +
					theme.fg("dim", ` → ${details.installedPath.replace(/\\/g, "/")}`),
				0,
				0,
			);
		},
	});

	// ─── /unity-install-bridge ──────────────────────────────────────────────
	// User-facing shortcut: install PiBridge into cwd's Unity project without
	// routing through the agent.
	pi.registerCommand("unity-install-bridge", {
		description: "Install PiBridge into the current Unity project (cwd). Overwrites any existing bridge files.",
		handler: async (_args, ctx) => {
			try {
				const result = await runUnityInstallBridge({ projectPath: ctx.cwd });
				ctx.ui.notify(formatInstallBridgeResult(result), "info");
			} catch (err) {
				ctx.ui.notify(`✗ ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

// ─── Formatters ────────────────────────────────────────────────────────────

function formatUnityLogResult(result: UnityLogResult): string {
	const lines: string[] = [];
	lines.push(`Unity Log — ${result.projectPath}`);
	lines.push("");

	if (result.sources.length === 0 || result.entries.length === 0) {
		lines.push("No matching log entries found.");
		lines.push("");
		lines.push("Log sources checked:");
		for (const src of result.sources) {
			const status = src.exists ? `(${src.sizeBytes} bytes, ${src.linesParsed} lines parsed)` : "(not found)";
			lines.push(`  ${src.kind}: ${src.path} ${status}`);
		}
		return lines.join("\n");
	}

	lines.push(`Found ${result.summary.total} entries:`);
	const sv = result.summary.bySeverity;
	const cat = result.summary.byCategory;
	lines.push(
		`  errors: ${sv.error ?? 0} | fatal: ${sv.fatal ?? 0} | warnings: ${sv.warning ?? 0} | compile: ${cat.compile ?? 0} | exceptions: ${cat.exception ?? 0}`,
	);
	lines.push("");

	lines.push(result.formatted);

	lines.push("");
	lines.push("Log sources:");
	for (const src of result.sources) {
		const status = src.exists ? `(${src.sizeBytes} bytes)` : "(not found)";
		lines.push(`  ${src.kind} [${src.source}]: ${src.path} ${status}`);
	}

	return lines.join("\n");
}

function formatUnityStatusResult(result: UnityStatusResult): string {
	const lines: string[] = [];
	lines.push(`Unity Status — ${result.projectPath}`);
	lines.push("");
	lines.push(`Version: ${result.unityVersion ?? "unknown"}`);
	lines.push(`Running: ${result.isRunning ? "yes" : "no"}`);
	lines.push(`Compiling: ${result.isCompiling ? "yes" : "no"}`);
	lines.push(`Importing: ${result.isImporting ? "yes" : "no"}`);
	lines.push(`Status source: ${result.statusSource}`);
	lines.push(`Lockfile exists: ${result.lockfileExists ? "yes" : "no"}${result.lockfileLocked ? " (locked)" : ""}`);

	if (result.isRunning) {
		lines.push("");
		lines.push("⚠ Unity is running. Do not launch a second instance for this project — it will fail with 'another Unity instance'.");
	}

	return lines.join("\n");
}

function formatUnityProjectResult(result: UnityProjectResult): string {
	const lines: string[] = [];
	lines.push(`Unity Project — ${result.projectPath}`);
	lines.push("");
	lines.push(`Version: ${result.unityVersion ?? "unknown"}`);
	lines.push(`Scripting backend: ${result.scriptingBackend ?? "unknown"}`);
	lines.push(`Force text serialization: ${result.forceTextSerialization === null ? "unknown" : result.forceTextSerialization ? "yes" : "no"}`);
	lines.push("");

	lines.push(`Assemblies (${result.assemblies.length}):`);
	for (const asm of result.assemblies.slice(0, 30)) {
		lines.push(`  ${asm.name}  (${asm.path})`);
		if (asm.references.length > 0) {
			lines.push(`    refs: ${asm.references.slice(0, 5).join(", ")}${asm.references.length > 5 ? ` +${asm.references.length - 5}` : ""}`);
		}
	}
	if (result.assemblies.length > 30) {
		lines.push(`  ... ${result.assemblies.length - 30} more`);
	}

	lines.push("");
	lines.push(`Packages (${result.packages.length}):`);
	for (const pkg of result.packages) {
		lines.push(`  ${pkg.name} @ ${pkg.version} [${pkg.source}]`);
	}

	return lines.join("\n");
}


function formatUnityCommandResult(result: UnityCommandResult): string {
	const lines: string[] = [];
	lines.push(`Unity Command — ${result.command} (${result.response.durationMs}ms)`);
	lines.push("");

	if (!result.bridge.available) {
		// Version mismatch: bridge is running but too old — guide the AI to update.
		if (result.bridge.versionMismatch) {
			const vm = result.bridge.versionMismatch;
			lines.push(`⚠ PiBridge is outdated (running v${vm.running}, requires v${vm.required}+).`);
			lines.push("");
			lines.push("The installed PiBridge.cs is older than this extension expects. Update it:");
			lines.push("  Call unity_install_bridge with this project's path to reinstall the latest PiBridge.cs.");
			lines.push("  Unity will recompile and restart the bridge automatically (~10-20s).");
			return lines.join("\n");
		}

		lines.push("⚠ PiBridge is not running.");
		lines.push("");
		lines.push("To enable unity_command, install PiBridge in this project:");
		lines.push("  Call unity_install_bridge with this project's path.");
		lines.push("  Unity will recompile and the bridge auto-starts (~10-20s). Check the Console for:");
		lines.push("  [PiBridge] Listening on http://127.0.0.1:PORT");
		if (result.bridge.reason) {
			lines.push("");
			lines.push(`Reason: ${result.bridge.reason}`);
		}
		return lines.join("\n");
	}

	lines.push(`Bridge: ${result.bridge.url} (v${result.bridge.version}, Unity ${result.bridge.unityVersion})`);
	lines.push("");

	if (result.response.ok) {
		lines.push("✓ Success");
		if (result.response.result !== undefined) {
			lines.push("");
			lines.push("Result:");
			lines.push(JSON.stringify(result.response.result, null, 2));
		}
	} else {
		lines.push("✗ Failed");
		if (result.response.error) {
			lines.push("");
			lines.push(`Error: ${result.response.error}`);
		}
		// Some commands return structured detail even on failure (e.g. eval returns
		// {kind, diagnostics, stack}). Surface it so the agent can diagnose without
		// having to read the raw response.
		if (result.response.result !== undefined && result.response.result !== null) {
			lines.push("");
			lines.push("Detail:");
			lines.push(JSON.stringify(result.response.result, null, 2));
		}
	}

	return lines.join("\n");
}

function formatInstallBridgeResult(result: UnityInstallBridgeResult): string {
	const lines: string[] = [];
	lines.push(`Installed PiBridge v${result.version}`);
	lines.push("");
	lines.push(`Path: ${result.installedPath} (${result.installedFiles.length} file${result.installedFiles.length === 1 ? "" : "s"})`);
	for (const f of result.installedFiles) {
		lines.push(`  • ${f.replace(/\\/g, "/")}`);
	}
	lines.push("");
	lines.push("Next steps:");
	for (const step of result.nextSteps) {
		lines.push(`  • ${step}`);
	}
	return lines.join("\n");
}

function formatUnityEventsResult(result: UnityEventsResult): string {
	const lines: string[] = [];
	lines.push(`Unity Events — ${result.projectPath}`);
	lines.push("");
	if (!result.bridge.available) {
		lines.push("⚠ PiBridge is not running.");
		lines.push("");
		lines.push("Open the Unity project and ensure PiBridge v0.6.0+ is installed, then retry.");
		if (result.bridge.reason) lines.push(`Reason: ${result.bridge.reason}`);
		return lines.join("\n");
	}
	lines.push(`Bridge: ${result.bridge.url} (v${result.bridge.version})`);
	lines.push("");
	if (result.response.ok) {
		lines.push("✓ Success");
		if (result.response.result !== undefined) {
			lines.push("");
			lines.push("Result:");
			lines.push(JSON.stringify(result.response.result, null, 2));
		}
		if (result.sseLoop === "running") {
			lines.push("");
			lines.push("Background SSE stream started — events arrive as custom unity-event messages (rendered with a [unity] prefix, may lag behind realtime).");
		} else if (result.sseLoop === "reused") {
			lines.push("");
			lines.push("Background SSE stream already running for this project — reusing it.");
		}
	} else {
		lines.push("✗ Failed");
		if (result.response.error) {
			lines.push("");
			lines.push(`Error: ${result.response.error}`);
		}
	}
	return lines.join("\n");
}
