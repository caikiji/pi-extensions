/**
 * Parse Unity log content into structured entries.
 *
 * Supported entry types (per research, grep-friendly formats):
 *   - Compile errors:   Assets/Scripts/Foo.cs(12,17): error CS0103: message
 *   - Compile warnings: Assets/Scripts/Foo.cs(12,17): warning CS0168: message
 *   - Runtime exceptions: ExceptionType: message  + multi-line stack trace
 *   - Asset import errors: [AssetImport] ... error ...
 *   - Package manager errors: [PackageManager] ...
 *   - General errors: "error:" prefix, "Fatal Error!", "Aborting batchmode"
 *
 * Module prefixes: [Compiler] [AssetImport] [PackageManager] [Assembly Updater] [Burst]
 */

export type LogSeverity = "error" | "warning" | "info" | "fatal";

export type LogCategory =
	| "compile" // CSxxxx compiler errors/warnings
	| "exception" // runtime exceptions with stack traces
	| "import" // asset import errors
	| "package" // package manager
	| "general"; // other errors/fatals

export interface LogEntry {
	severity: LogSeverity;
	category: LogCategory;
	message: string;
	file?: string;
	line?: number;
	col?: number;
	code?: string; // e.g. "CS0103"
	stack?: string[]; // stack trace lines
	raw: string; // original line(s)
}

export type LogFilter = "errors" | "warnings" | "compile" | "exceptions" | "all";

const MODULE_PREFIXES = [
	"Compiler",
	"AssetImport",
	"PackageManager",
	"Assembly Updater",
	"Burst",
	"Analytics",
	"Physics",
	"VR",
	"XR",
] as const;

/**
 * Parse a single compile error/warning line.
 * Format: <file>(<line>,<col>): error|warning CSxxxx: message
 * Also matches without col: <file>(<line>): error CSxxxx: message
 */
const COMPILE_LINE_REGEX =
	/^(.+?)\((\d+)(?:,(\d+))?\):\s*(error|warning)\s+(CS\d+):\s*(.+)$/;

/**
 * Parse an exception header line.
 * Format: <ExceptionType>: <message>
 * May also be prefixed with module: [PackageManager] <ExceptionType>: <message>
 */
const EXCEPTION_HEADER_REGEX = /^(?:\[[^\]]+\]\s*)?([A-Za-z_][\w.]*(?:Exception|Error)):\s*(.+)$/;

/**
 * Parse all log entries from content, applying optional filters.
 */
export function parseLog(content: string, filter: LogFilter = "errors"): LogEntry[] {
	const lines = content.split("\n");
	const entries: LogEntry[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		// 1. Compile errors/warnings (most structured, highest priority)
		const compileMatch = line.match(COMPILE_LINE_REGEX);
		if (compileMatch) {
			const [, file, lineStr, colStr, severity, code, message] = compileMatch;
			entries.push({
				severity: severity as LogSeverity,
				category: "compile",
				file: file.trim(),
				line: Number.parseInt(lineStr, 10),
				col: colStr ? Number.parseInt(colStr, 10) : undefined,
				code,
				message: message.trim(),
				raw: line,
			});
			i++;
			continue;
		}

		// 2. Exceptions (header + multi-line stack trace)
		const exceptionMatch = line.match(EXCEPTION_HEADER_REGEX);
		if (exceptionMatch && !isNoiseLine(line)) {
			const [, excType, message] = exceptionMatch;
			const stack: string[] = [];
			const rawLines = [line];
			let j = i + 1;
			// Collect stack trace lines: indented "at ..." frames, or any indented
			// continuation that isn't itself a new compile error or exception header.
			while (j < lines.length) {
				const nextLine = lines[j];
				if (nextLine.trim() === "") break;
				if (
					/^\s+at\s/.test(nextLine) ||
					(nextLine.startsWith(" ") && !COMPILE_LINE_REGEX.test(nextLine) && !EXCEPTION_HEADER_REGEX.test(nextLine))
				) {
					stack.push(nextLine);
					rawLines.push(nextLine);
					j++;
				} else {
					break;
				}
			}
			entries.push({
				severity: "error",
				category: "exception",
				message: `${excType}: ${message.trim()}`,
				stack: stack.length > 0 ? stack : undefined,
				raw: rawLines.join("\n"),
			});
			i = j;
			continue;
		}

		// 3. Module-prefixed errors (AssetImport, PackageManager, etc.)
		const moduleEntry = parseModuleLine(line);
		if (moduleEntry) {
			entries.push(moduleEntry);
			i++;
			continue;
		}

		// 4. Fatal errors and aborts
		if (/Fatal Error!|Aborting batchmode|FATAL ERROR/i.test(line)) {
			entries.push({
				severity: "fatal",
				category: "general",
				message: line.trim(),
				raw: line,
			});
			i++;
			continue;
		}

		// 5. Generic "error:" lines (not compile errors, caught above)
		// Match "error:" but exclude "0 errors" / "error CS" (already handled)
		const genericErrorMatch = line.match(/(?:^|\s)error:\s+(.+)$/i);
		if (genericErrorMatch && !/\d+\s+errors?/i.test(line) && !line.match(COMPILE_LINE_REGEX)) {
			entries.push({
				severity: "error",
				category: "general",
				message: genericErrorMatch[1].trim(),
				raw: line,
			});
			i++;
			continue;
		}

		i++;
	}

	return applyFilter(entries, filter);
}

/**
 * Parse a module-prefixed line like "[AssetImport] error: ..." or "[PackageManager] ..."
 */
function parseModuleLine(line: string): LogEntry | null {
	const moduleRegex = new RegExp(`^\\[(${MODULE_PREFIXES.join("|")})\\]\\s*(.+)$`, "i");
	const match = line.match(moduleRegex);
	if (!match) return null;

	const [, module, rest] = match;
	const moduleLower = module.toLowerCase();

	let category: LogCategory = "general";
	if (moduleLower === "assetimport") category = "import";
	else if (moduleLower === "packagemanager") category = "package";
	else if (moduleLower === "compiler") category = "compile";

	let severity: LogSeverity = "info";
	if (/error|fail/i.test(rest)) severity = "error";
	if (/fatal|abort/i.test(rest)) severity = "fatal";
	if (/warn/i.test(rest)) severity = "warning";

	// Only return as an entry if it's an error/warning/fatal, skip pure info
	if (severity === "info") return null;

	return {
		severity,
		category,
		message: rest.trim(),
		raw: line,
	};
}

/**
 * Filter out non-error noise lines that might match exception regex.
 * E.g. "UnityEngine.Debug:LogWarning" in a stack trace.
 */
function isNoiseLine(line: string): boolean {
	const trimmed = line.trim();
	// Stack trace continuation lines
	if (trimmed.startsWith("at ") || trimmed.startsWith("UnityEngine.") || trimmed.startsWith("UnityEditor.")) {
		return true;
	}
	return false;
}

/**
 * Apply a filter to parsed entries.
 */
function applyFilter(entries: LogEntry[], filter: LogFilter): LogEntry[] {
	switch (filter) {
		case "errors":
			return entries.filter((e) => e.severity === "error" || e.severity === "fatal");
		case "warnings":
			return entries.filter((e) => e.severity === "warning");
		case "compile":
			return entries.filter((e) => e.category === "compile");
		case "exceptions":
			return entries.filter((e) => e.category === "exception");
		case "all":
			return entries;
	}
}

/**
 * Format parsed entries as human-readable text for the LLM.
 */
export function formatEntries(entries: LogEntry[], maxEntries = 50): string {
	if (entries.length === 0) return "(no matching log entries)";

	const lines: string[] = [];
	const display = entries.slice(0, maxEntries);

	for (const entry of display) {
		const severityTag =
			entry.severity === "fatal" ? "FATAL" : entry.severity === "error" ? "ERROR" : entry.severity === "warning" ? "WARN" : "INFO";

		let line = `[${severityTag}]`;
		if (entry.code) line += ` ${entry.code}`;
		if (entry.file) {
			line += ` ${entry.file}`;
			if (entry.line) line += `(${entry.line}${entry.col ? `,${entry.col}` : ""})`;
		}
		line += `: ${entry.message}`;
		lines.push(line);

		if (entry.stack && entry.stack.length > 0) {
			for (const stackLine of entry.stack.slice(0, 8)) {
				lines.push(`    ${stackLine.trim()}`);
			}
			if (entry.stack.length > 8) {
				lines.push(`    ... ${entry.stack.length - 8} more stack frames`);
			}
		}
	}

	if (entries.length > maxEntries) {
		lines.push(`\n... ${entries.length - maxEntries} more entries (use a tighter filter to see all)`);
	}

	return lines.join("\n");
}

/**
 * Summarize entry counts by severity and category.
 */
export function summarizeEntries(entries: LogEntry[]): {
	total: number;
	bySeverity: Record<LogSeverity, number>;
	byCategory: Record<LogCategory, number>;
} {
	const bySeverity: Record<LogSeverity, number> = { error: 0, warning: 0, info: 0, fatal: 0 };
	const byCategory: Record<LogCategory, number> = {
		compile: 0,
		exception: 0,
		import: 0,
		package: 0,
		general: 0,
	};

	for (const entry of entries) {
		bySeverity[entry.severity]++;
		byCategory[entry.category]++;
	}

	return { total: entries.length, bySeverity, byCategory };
}
