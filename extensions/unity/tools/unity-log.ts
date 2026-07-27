/**
 * unity_log tool — read and parse Unity log files.
 *
 * Lets the AI see what Unity is doing: compile errors, runtime exceptions,
 * asset import errors, package manager errors. Returns structured entries.
 *
 * Log location priority (per Unity docs 2019.4+):
 *   - Project-level: <projectPath>/Logs/Editor.log (default)
 *   - Global: only with -useGlobalLog (fallback if project log missing)
 *
 * For the Editor console, when PiBridge is running this tool prefers the
 * bridge's structured /log endpoint over parsing Editor.log: the bridge
 * returns live entries (including info-level Debug.Log) that the file parser
 * (error/exception-only) would miss, and sidesteps Editor.log format quirks.
 * Import/package/player logs always come from files (no bridge equivalent).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { discoverBridge, sendCommand, PORT_FILE } from "../lib/bridge-client.ts";
import { filterSince, readEditorLog, readImportLogs, readPackageLog, readPlayerLog, tail, type LogKind } from "../lib/editor-log.ts";
import {
	formatEntries,
	parseLog,
	summarizeEntries,
	type LogCategory,
	type LogEntry,
	type LogFilter,
	type LogSeverity,
} from "../lib/log-parser.ts";
import { resolveProjectPath } from "../lib/tool-utils.ts";

export const unityLogParams = Type.Object({
	projectPath: Type.Optional(
		Type.String({ description: "Path to Unity project root. Defaults to auto-detect from cwd." }),
	),
	kind: Type.Optional(
		StringEnum(["editor", "import", "package", "player", "all"] as const),
	),
	filter: Type.Optional(
		StringEnum(["errors", "warnings", "compile", "exceptions", "all"] as const),
	),
	tail: Type.Optional(
		Type.Number({ description: "Only parse the last N lines (default 500). Use to limit large logs.", minimum: 1 }),
	),
	since: Type.Optional(
		Type.String({ description: "ISO 8601 timestamp. Only parse lines after this time (requires -timestamps in Unity)." }),
	),
	companyName: Type.Optional(
		Type.String({ description: "Company name for player log resolution. Only used when kind='player'." }),
	),
	productName: Type.Optional(
		Type.String({ description: "Product name for player log resolution. Only used when kind='player'." }),
	),
});

export interface UnityLogParams {
	projectPath?: string;
	kind?: LogKind;
	filter?: LogFilter;
	tail?: number;
	since?: string;
	companyName?: string;
	productName?: string;
}

export interface UnityLogResult {
	projectPath: string;
	sources: Array<{
		kind: LogKind;
		path: string;
		source: "project" | "global" | "bridge";
		exists: boolean;
		sizeBytes: number;
		linesParsed: number;
	}>;
	entries: LogEntry[];
	summary: {
		total: number;
		bySeverity: Record<string, number>;
		byCategory: Record<string, number>;
	};
	formatted: string;
}

/** Bridge /log entry shape (see PiBridge.cs GetLogEntries). severity ∈ error|assert|exception|warning|log. */
interface BridgeLogEntry {
	message: string;
	file: string | null;
	line: number;
	column: number;
	mode: number;
	severity: string;
}

/** Map the bridge severity to the /log `severity` request param (coarse filter done server-side). */
function bridgeSeverityFor(filter: LogFilter): string {
	switch (filter) {
		case "errors":
			return "error"; // bridge "error" includes assert + exception
		case "warnings":
			return "warning";
		case "exceptions":
			return "error"; // exceptions are errors; refined to category below
		default:
			return ""; // "all" and "compile" — fetch all, refine client-side
	}
}

/** Convert a bridge /log entry into the shared LogEntry shape. */
function mapBridgeEntry(e: BridgeLogEntry): LogEntry {
	const severity: LogSeverity = e.severity === "warning" ? "warning" : e.severity === "log" ? "info" : "error";
	const codeMatch = e.message.match(/\b(CS\d+)\b/);
	const code = codeMatch?.[1];
	const category: LogCategory = e.severity === "exception" ? "exception" : code ? "compile" : "general";
	return {
		severity,
		category,
		message: e.message.trim(),
		file: e.file ?? undefined,
		line: e.line || undefined,
		col: e.column || undefined,
		code,
		raw: `[${e.severity}] ${e.file ? `${e.file}(${e.line}): ` : ""}${e.message}`,
	};
}

/** Map bridge entries and apply the fine-grained post-filter (compile/exceptions) the coarse server filter can't express. */
function mapBridgeEntries(raw: BridgeLogEntry[], filter: LogFilter): LogEntry[] {
	const entries = raw.map(mapBridgeEntry);
	switch (filter) {
		case "compile":
			return entries.filter((e) => e.category === "compile");
		case "exceptions":
			return entries.filter((e) => e.category === "exception");
		default:
			// errors/warnings/all already coarse-filtered by the bridge severity param
			return entries;
	}
}

export async function runUnityLog(params: UnityLogParams, cwd: string): Promise<UnityLogResult> {
	const projectPath = resolveProjectPath(params.projectPath, cwd);
	const kind = params.kind ?? "editor";
	const filter = params.filter ?? "errors";
	const tailLines = params.tail ?? 500;

	const sources: UnityLogResult["sources"] = [];
	const allEntries: LogEntry[] = [];

	let requestedKinds: LogKind[] = kind === "all" ? ["editor", "import", "package", "player"] : [kind];

	// Prefer the bridge /log for the Editor console when available: it returns
	// live entries (incl. info-level Debug.Log) the file parser would miss, and
	// avoids Editor.log format quirks. Skipped when `since` is set (bridge
	// entries carry no timestamps) or when no port file exists (bridge absent —
	// avoids 20-port probing latency).
	const portFile = join(projectPath, "Temp", PORT_FILE);
	if (requestedKinds.includes("editor") && !params.since && existsSync(portFile)) {
		const bridge = await discoverBridge(projectPath);
		if (bridge.available) {
			const resp = await sendCommand<{ entries: BridgeLogEntry[]; count: number; totalCounts: Record<string, number> }>(
				bridge.port!,
				"log",
				{ count: tailLines, severity: bridgeSeverityFor(filter) },
				10000,
			);
			if (resp.ok && resp.result?.entries) {
				const entries = mapBridgeEntries(resp.result.entries, filter);
				allEntries.push(...entries);
				sources.push({
					kind: "editor",
					path: `${bridge.url}/log`,
					source: "bridge",
					exists: true,
					sizeBytes: resp.result.count ?? entries.length,
					linesParsed: entries.length,
				});
				requestedKinds = requestedKinds.filter((k) => k !== "editor");
			}
			// If the bridge call failed, leave "editor" in requestedKinds so the
			// file-reading fallback below handles it.
		}
	}

	for (const k of requestedKinds) {
		let content: string;
		let path: string;
		let source: "project" | "global" = "project";
		let exists = false;
		let sizeBytes = 0;

		if (k === "editor") {
			const result = readEditorLog(projectPath);
			content = result.content;
			path = result.path;
			source = result.source;
			exists = result.exists;
			sizeBytes = result.sizeBytes;
		} else if (k === "import") {
			const logs = readImportLogs(projectPath);
			content = logs.map((l) => l.content).join("\n");
			path = logs.length > 0 ? `${logs[0].path} (+${logs.length - 1} more)` : "(no import logs)";
			exists = logs.length > 0;
			sizeBytes = logs.reduce((sum, l) => sum + l.sizeBytes, 0);
		} else if (k === "package") {
			const result = readPackageLog();
			content = result.content;
			path = result.path;
			exists = result.exists;
			sizeBytes = result.sizeBytes;
		} else {
			// player
			const result = readPlayerLog(params.companyName, params.productName);
			content = result.content;
			path = result.path;
			exists = result.exists;
			sizeBytes = result.sizeBytes;
		}

		if (!exists) {
			sources.push({ kind: k, path, source, exists: false, sizeBytes: 0, linesParsed: 0 });
			continue;
		}

		// Apply since filter (if timestamps present)
		let processedContent = content;
		if (params.since) {
			processedContent = filterSince(processedContent, params.since);
		}

		// Apply tail
		processedContent = tail(processedContent, tailLines);

		// Parse
		const entries = parseLog(processedContent, filter);
		allEntries.push(...entries);

		sources.push({
			kind: k,
			path,
			source,
			exists: true,
			sizeBytes,
			linesParsed: processedContent.split("\n").length,
		});
	}

	const summary = summarizeEntries(allEntries);
	const formatted = formatEntries(allEntries, 100);

	return {
		projectPath,
		sources,
		entries: allEntries,
		summary: {
			total: summary.total,
			bySeverity: summary.bySeverity as Record<string, number>,
			byCategory: summary.byCategory as Record<string, number>,
		},
		formatted,
	};
}
