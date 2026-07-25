/**
 * unity_log tool — read and parse Unity log files.
 *
 * Lets the AI see what Unity is doing: compile errors, runtime exceptions,
 * asset import errors, package manager errors. Returns structured entries.
 *
 * Log location priority (per Unity docs 2019.4+):
 *   - Project-level: <projectPath>/Logs/Editor.log (default)
 *   - Global: only with -useGlobalLog (fallback if project log missing)
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { filterSince, readEditorLog, readImportLogs, readPackageLog, readPlayerLog, tail, type LogKind } from "../lib/editor-log.ts";
import { formatEntries, parseLog, summarizeEntries, type LogEntry, type LogFilter } from "../lib/log-parser.ts";
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
		source: "project" | "global";
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

export async function runUnityLog(params: UnityLogParams, cwd: string): Promise<UnityLogResult> {
	const projectPath = resolveProjectPath(params.projectPath, cwd);
	const kind = params.kind ?? "editor";
	const filter = params.filter ?? "errors";
	const tailLines = params.tail ?? 500;

	const sources: UnityLogResult["sources"] = [];
	const allEntries: LogEntry[] = [];

	const requestedKinds: LogKind[] = kind === "all" ? ["editor", "import", "package", "player"] : [kind];

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
