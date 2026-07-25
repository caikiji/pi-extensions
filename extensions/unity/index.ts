/**
 * Unity Editor integration extension for pi.
 *
 * Lets the AI coding agent:
 *   - Read Unity logs (compile errors, exceptions, import errors)
 *   - Detect Unity running/compiling/importing state
 *   - Read project metadata (version, assemblies, packages)
 *   - Execute Unity Editor scripts via batchmode (with safe result verification)
 *
 * Supports Unity 2019.4 LTS and later (2020.3 / 2021.3 / 2022.3 / Unity 6).
 *
 * See README.md for full design and the result-passing convention.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runBatchmode } from "./lib/batchmode.ts";
import { runUnityCommand, unityCommandParams, type UnityCommandResult } from "./tools/unity-command.ts";
import { runUnityInstallBridge, unityInstallBridgeParams, type UnityInstallBridgeResult } from "./tools/unity-install-bridge.ts";
import { runUnityLog, unityLogParams, type UnityLogResult } from "./tools/unity-log.ts";
import { runUnityProject, unityProjectParams, type UnityProjectResult } from "./tools/unity-project.ts";
import { runUnityRun, unityRunParams, type UnityRunResult } from "./tools/unity-run.ts";
import { runUnityStatus, unityStatusParams, type UnityStatusResult } from "./tools/unity-status.ts";

export default function (pi: ExtensionAPI) {
	// ─── unity_log ──────────────────────────────────────────────────────────
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
			"Use unity_status before starting a long Unity operation or batchmode run to avoid conflicts with an already-running Editor instance.",
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
			return new Text(`${running} ${version}`, 0, 0);
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

	// ─── unity_run ──────────────────────────────────────────────────────────
	pi.registerTool({
		name: "unity_run",
		label: "Unity Run",
		description:
			"Execute a static Unity Editor method via batchmode (`Unity.exe -batchmode -executeMethod`). " +
			"The method must be static, parameterless, and in an Editor assembly. " +
			"Results are triple-verified (exit code + log errors + optional result JSON file) because Unity exit codes are unreliable. " +
			"The script can write results to Temp/pi-result.json (or a custom resultFile) and the tool returns the parsed JSON. " +
			"WARNING: This launches Unity, which is slow (30s+ cold start). Use only for tasks that require the Unity API (AssetDatabase, BuildPipeline, etc.).",
		promptSnippet: "Run a Unity Editor script via batchmode (slow, launches Unity)",
		promptGuidelines: [
			"Use unity_run only when you need the Unity Editor API (AssetDatabase, BuildPipeline, SceneManager). For reading files, prefer read/grep/bash instead of launching Unity.",
			"Before calling unity_run, check unity_status to ensure Unity isn't already running — concurrent instances on the same project will fail.",
			"unity_run scripts should write results to Temp/pi-result.json via File.WriteAllText for reliable structured output, since Unity exit codes are unreliable.",
		],
		parameters: unityRunParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const result = await runUnityRun(params, ctx.cwd, onUpdate, signal);
			return {
				content: [{ type: "text", text: formatUnityRunResult(result) }],
				details: result,
			};
		},

		renderResult(result, _options, theme) {
			const details = result.details as UnityRunResult | undefined;
			if (!details) return new Text(theme.fg("dim", "(no result)"), 0, 0);
			const status = details.success
				? theme.fg("success", "✓ success")
				: details.timedOut
					? theme.fg("error", "✗ timeout")
					: details.cancelled
						? theme.fg("warning", "✗ cancelled")
						: theme.fg("error", "✗ failed");
			const duration = `${(details.durationMs / 1000).toFixed(1)}s`;
			const errorCount = details.errors.length;
			const errors = errorCount > 0 ? theme.fg("error", ` ${errorCount} err`) : "";
			return new Text(`${status} ${theme.fg("dim", duration)}${errors}`, 0, 0);
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
			"status (isCompiling/isPlaying/isUpdating), run-menu (execute a menu item — RISKY: can open a modal dialog that freezes Unity's main thread and makes the bridge unresponsive; 15s timeout, refuses if a dialog is already open), asset-info (load asset metadata), " +
			"log (read recent Console entries), eval (call a static method, needs PI_BRIDGE_ALLOW_EVAL=1). " +
			"Unlike unity_run, this does NOT launch a new Unity process — it drives the already-open Editor.",
		promptSnippet: "Run a command in the open Unity Editor via PiBridge HTTP bridge",
		promptGuidelines: [
			"Use unity_command (not unity_run) when Unity is already open for the project — it drives the running instance via HTTP, avoiding a 30s+ cold start.",
			"Before unity_command, the PiBridge.cs file must be in Assets/Editor/. If unity_command reports 'PiBridge is not running', use unity_install_bridge to install it, then tell the user to focus Unity so it recompiles.",
			"After unity_command with 'compile' or 'refresh', poll unity_command status (or unity_status) until isCompiling becomes false — the Editor throttles when unfocused, so completion is not instant.",
			"unity_command run-menu is risky: ExecuteMenuItem is blocking and can open a modal dialog that freezes Unity's main thread, making the bridge unresponsive. Prefer dedicated commands (refresh/compile/status) over run-menu. If run-menu times out, tell the user a dialog may be open in Unity and they should close it, then verify with ping.",
		],
		parameters: unityCommandParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runUnityCommand(params, ctx.cwd);
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

	// ─── unity_install_bridge ───────────────────────────────────────────────
	// Auto-installs PiBridge.cs into a Unity project so unity_command works.
	// The AI can set up the bridge for any project given just the path.
	pi.registerTool({
		name: "unity_install_bridge",
		label: "Install PiBridge",
		description:
			"Install PiBridge.cs into a Unity project so unity_command can drive its running Editor. " +
			"Copies the bundled PiBridge.cs to <projectPath>/Assets/Editor/PiBridge.cs. " +
			"Creates Assets/Editor/ if missing. If the file already exists, backs it up to PiBridge.cs.bak (unless overwrite=true). " +
			"After install, Unity auto-compiles on focus and the bridge starts — then unity_command becomes usable. " +
			"Use this BEFORE unity_command when the bridge is not yet installed in a project.",
		promptSnippet: "Install PiBridge.cs into a Unity project (enables unity_command)",
		promptGuidelines: [
			"Use unity_install_bridge to set up PiBridge for a project before using unity_command. It only writes one file (Assets/Editor/PiBridge.cs) and backs up any existing version.",
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
			const tag = details.alreadyExisted ? "updated" : "installed";
			return new Text(
				theme.fg("success", `✓ ${tag} `) + theme.fg("accent", `v${details.version}`) +
					theme.fg("dim", ` → ${details.installedPath.replace(/\\/g, "/")}`),
				0,
				0,
			);
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
	lines.push(`Lockfile exists: ${result.lockfileExists ? "yes" : "no"}${result.lockfileLocked ? " (locked)" : ""}`);

	if (result.isRunning) {
		lines.push("");
		lines.push("⚠ Unity is running. Do not start batchmode — it will fail with 'another Unity instance'.");
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

function formatUnityRunResult(result: UnityRunResult): string {
	const lines: string[] = [];
	lines.push(`Unity Run — ${result.method} (${(result.durationMs / 1000).toFixed(1)}s)`);
	lines.push("");

	if (result.timedOut) {
		lines.push(`✗ TIMED OUT after ${result.durationMs / 1000}s`);
	} else if (result.cancelled) {
		lines.push("✗ CANCELLED");
	} else if (result.success) {
		lines.push(`✓ SUCCESS (exit code ${result.exitCode})`);
	} else {
		lines.push(`✗ FAILED (exit code ${result.exitCode})`);
	}

	lines.push(`Unity: ${result.unityPath}`);
	lines.push(`Log: ${result.logPath}`);

	if (result.errors.length > 0) {
		lines.push("");
		lines.push(`Errors (${result.errors.length}):`);
		for (const err of result.errors.slice(0, 20)) {
			const loc = err.file ? ` ${err.file}${err.line ? `(${err.line})` : ""}` : "";
			lines.push(`  [${err.severity}]${loc} ${err.message}`);
		}
		if (result.errors.length > 20) {
			lines.push(`  ... ${result.errors.length - 20} more`);
		}
	}

	if (result.result !== null) {
		lines.push("");
		lines.push("Result JSON:");
		lines.push(JSON.stringify(result.result, null, 2));
	} else if (result.resultPath) {
		lines.push("");
		lines.push(`Result file existed but was not valid JSON: ${result.resultPath}`);
	}

	return lines.join("\n");
}

function formatUnityCommandResult(result: UnityCommandResult): string {
	const lines: string[] = [];
	lines.push(`Unity Command — ${result.command} (${result.response.durationMs}ms)`);
	lines.push("");

	if (!result.bridge.available) {
		lines.push("⚠ PiBridge is not running.");
		lines.push("");
		lines.push("To enable unity_command, add PiBridge.cs to your project:");
		lines.push("  1. Copy extensions/unity/PiBridge.cs to <project>/Assets/Editor/");
		lines.push("  2. (Re)open the project in Unity — the bridge auto-starts on load");
		lines.push("  3. Check the Unity Console for: [PiBridge] Listening on http://127.0.0.1:PORT");
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
	}

	return lines.join("\n");
}

function formatInstallBridgeResult(result: UnityInstallBridgeResult): string {
	const lines: string[] = [];
	const action = result.alreadyExisted ? "Updated" : "Installed";
	lines.push(`${action} PiBridge v${result.version}`);
	lines.push("");
	lines.push(`Path: ${result.installedPath}`);
	if (result.backupPath) {
		lines.push(`Backed up existing file to: ${result.backupPath}`);
	}
	lines.push("");
	lines.push("Next steps:");
	for (const step of result.nextSteps) {
		lines.push(`  • ${step}`);
	}
	return lines.join("\n");
}
