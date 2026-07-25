/**
 * Unity batchmode execution wrapper.
 *
 * Safely runs `Unity.exe -batchmode -executeMethod ...` and captures results.
 *
 * Key safety measures (per research):
 *   1. Triple verification: exit code + log errors + result-file JSON
 *      (Unity exit codes are unreliable: Analytics-enabled builds return 0
 *       even on compile errors; upmPack returns 1 on success)
 *   2. Project-level file lock prevents concurrent Unity instances
 *      (Unity hard-limits one instance per project via Temp/UnityLockfile)
 *   3. Layered timeout: external process timeout > -quitTimeout
 *   4. Safe cancel: SIGTERM -> wait -> SIGKILL -> cleanup Temp/UnityLockfile
 *   5. Real-time stdout/log tail via onUpdate for progress feedback
 *   6. Path safety: Windows -projectPath cannot end with single backslash
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverUnityInstall, getUnityLockfilePath, isFileLocked } from "./paths.ts";
import { parseLog } from "./log-parser.ts";

/** Progress callback type — matches pi's AgentToolUpdateCallback signature. */
export type ProgressCallback = (partialResult: {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
}) => void;

export interface BatchmodeOptions {
	projectPath: string;
	method: string; // fully-qualified: NS.Class.Method
	args?: string[]; // extra command-line args passed through to the script
	timeout?: number; // seconds, default 600
	quitTimeout?: number; // Unity -quitTimeout, default = timeout - 60
	extraArgs?: string[]; // extra Unity CLI args (e.g. -buildTarget Android)
	resultFile?: string; // path to JSON result written by the script
	logFile?: string; // custom log file path (default: Temp/pi-unity-run.log)
	unityPath?: string; // override Unity.exe path
	onUpdate?: ProgressCallback;
	signal?: AbortSignal;
}

export interface BatchmodeResult {
	exitCode: number | null;
	success: boolean; // triple-verified
	durationMs: number;
	unityPath: string;
	logPath: string;
	resultPath: string | null;
	result: unknown | null; // parsed JSON from resultFile
	errors: Array<{ severity: string; category: string; message: string; file?: string; line?: number }>;
	timedOut: boolean;
	cancelled: boolean;
	stdout: string; // last N lines
}

const DEFAULT_TIMEOUT = 600; // 10 minutes
const STDOUT_TAIL_LINES = 100;

/**
 * Execute a Unity batchmode method.
 *
 * The method must be a static, parameterless method in an Editor assembly.
 * Results are verified three ways:
 *   1. Exit code (0 = ok, but unreliable — see above)
 *   2. Log error entries (compile errors, exceptions, fatals)
 *   3. Optional resultFile JSON (script writes structured output)
 *
 * Success = (exitCode === 0) AND (no fatal/error log entries) AND
 *           (resultFile either absent or valid JSON).
 */
export async function runBatchmode(options: BatchmodeOptions): Promise<BatchmodeResult> {
	const projectPath = resolve(options.projectPath);
	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	const quitTimeout = options.quitTimeout ?? Math.max(60, timeout - 60);

	// 1. Discover Unity executable
	const install = options.unityPath
		? { path: options.unityPath, version: "override", source: "override" as const }
		: discoverUnityInstall(projectPath);
	if (!install) {
		throw new Error(
			"Could not find Unity Editor installation. Set UNITY_EDITOR_PATH env var, install via Unity Hub, " +
				"or pass unityPath explicitly.",
		);
	}

	// 2. Ensure Temp/ exists for logs and result
	const tempDir = join(projectPath, "Temp");
	mkdirSync(tempDir, { recursive: true });

	// 3. Set up log and result file paths
	const logPath = options.logFile ?? join(tempDir, "pi-unity-run.log");
	const resultPath = options.resultFile ?? join(tempDir, "pi-result.json");

	// 4. Check for existing Unity instance (lockfile)
	const lockfilePath = getUnityLockfilePath(projectPath);
	if (existsSync(lockfilePath) && isFileLocked(lockfilePath)) {
		throw new Error(
			`Unity is already running for this project (Temp/UnityLockfile is locked).\n` +
				`Close Unity first, or if Unity crashed, delete: ${lockfilePath}`,
		);
	}

	// 5. Acquire our own advisory lock to prevent concurrent batchmode calls
	const ourLockPath = join(tempDir, "pi-batchmode.lock");
	try {
		const fd = openSync(ourLockPath, "wx"); // exclusive create
		writeFileSync(fd, `${process.pid}\n`);
		closeSync(fd);
	} catch {
		throw new Error(
			"Another pi-unity batchmode run is already in progress for this project. Wait for it to finish.",
		);
	}

	const startTime = Date.now();
	let child: ChildProcess | null = null;
	let timedOut = false;
	let cancelled = false;
	let stdoutBuffer = "";

	try {
		// 6. Build command-line arguments
		const cliArgs = buildUnityArgs({
			projectPath,
			method: options.method,
			logPath,
			quitTimeout,
			extraArgs: options.extraArgs,
			scriptArgs: options.args,
		});

		// Notify start
		options.onUpdate?.({
			content: [{ type: "text", text: `Starting Unity batchmode...\n  ${install.path}\n  method: ${options.method}` }],
			details: { phase: "start", method: options.method },
		});

		// 7. Spawn Unity process
		child = spawn(install.path, cliArgs, {
			cwd: projectPath,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		// 8. Collect stdout/stderr (Unity with -logFile writes to file, but
		//    some output may still appear on stdout/stderr)
		child.stdout?.on("data", (data: Buffer) => {
			const text = data.toString("utf-8");
			stdoutBuffer += text;
			// Keep only the tail to bound memory
			const lines = stdoutBuffer.split("\n");
			if (lines.length > STDOUT_TAIL_LINES * 2) {
				stdoutBuffer = lines.slice(-STDOUT_TAIL_LINES).join("\n");
			}
		});
		child.stderr?.on("data", (data: Buffer) => {
			stdoutBuffer += data.toString("utf-8");
		});

		// 9. Periodically tail the log file for progress updates
		const progressInterval = setInterval(() => {
			const progress = readLogTail(logPath, 5);
			if (progress) {
				options.onUpdate?.({
					content: [{ type: "text", text: progress }],
					details: { phase: "progress", tail: progress },
				});
			}
		}, 5000);

		// 10. Set up timeout
		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			if (child && !child.killed) {
				child.kill("SIGTERM");
				// Force kill after 5s
				setTimeout(() => {
					if (child && !child.killed) {
						child.kill("SIGKILL");
					}
				}, 5000);
			}
		}, timeout * 1000);

		// 11. Set up cancellation via AbortSignal
		let abortHandler: (() => void) | null = null;
		if (options.signal) {
			abortHandler = () => {
				cancelled = true;
				if (child && !child.killed) {
					child.kill("SIGTERM");
					setTimeout(() => {
						if (child && !child.killed) child.kill("SIGKILL");
					}, 5000);
				}
			};
			options.signal.addEventListener("abort", abortHandler);
		}

		// 12. Wait for process exit
		const exitCode = await new Promise<number | null>((resolveExit) => {
			child?.on("exit", (code) => resolveExit(code));
			child?.on("error", () => resolveExit(-1));
		});

		clearTimeout(timeoutHandle);
		clearInterval(progressInterval);
		if (options.signal && abortHandler) {
			options.signal.removeEventListener("abort", abortHandler);
		}

		// 13. Read final log and result file (triple verification)
		await new Promise((r) => setTimeout(r, 500)); // let file flush
		const logContent = readLogContent(logPath);
		const logErrors = parseLog(logContent, "errors");

		let result: unknown = null;
		let resultRead = false;
		if (existsSync(resultPath)) {
			try {
				result = JSON.parse(readFileSync(resultPath, "utf-8"));
				resultRead = true;
			} catch {
				// result file exists but not valid JSON — treat as error
			}
		}

		// 14. Triple verification
		const hasFatalErrors = logErrors.some((e) => e.severity === "error" || e.severity === "fatal");
		const success = !timedOut && !cancelled && exitCode === 0 && !hasFatalErrors && (existsSync(resultPath) ? resultRead : true);

		return {
			exitCode,
			success,
			durationMs: Date.now() - startTime,
			unityPath: install.path,
			logPath,
			resultPath: existsSync(resultPath) ? resultPath : null,
			result: resultRead ? result : null,
			errors: logErrors.map((e) => ({
				severity: e.severity,
				category: e.category,
				message: e.message,
				file: e.file,
				line: e.line,
			})),
			timedOut,
			cancelled,
			stdout: tailText(stdoutBuffer, STDOUT_TAIL_LINES),
		};
	} finally {
		// 15. Cleanup: release our lock, and clean up Unity's lockfile if Unity crashed
		try {
			unlinkSync(ourLockPath);
		} catch {
			// already gone
		}
		// If Unity was killed/timed out, its UnityLockfile may remain
		if ((timedOut || cancelled) && existsSync(lockfilePath)) {
			try {
				// Only delete if not currently locked by a live process
				if (!isFileLocked(lockfilePath)) {
					unlinkSync(lockfilePath);
				}
			} catch {
				// best-effort
			}
		}
	}
}

interface BuildArgsParams {
	projectPath: string;
	method: string;
	logPath: string;
	quitTimeout: number;
	extraArgs?: string[];
	scriptArgs?: string[];
}

/**
 * Build the Unity CLI argument list.
 *
 * Path safety: Windows -projectPath cannot end with a single backslash.
 * We normalize by removing trailing slashes (Unity accepts both).
 */
function buildUnityArgs(params: BuildArgsParams): string[] {
	const args: string[] = [
		"-batchmode",
		"-nographics",
		"-quit",
		"-quitTimeout",
		String(params.quitTimeout),
		"-projectPath",
		normalizeProjectPath(params.projectPath),
		"-logFile",
		params.logPath,
		"-executeMethod",
		params.method,
	];

	if (params.extraArgs) {
		args.push(...params.extraArgs);
	}
	if (params.scriptArgs) {
		args.push(...params.scriptArgs);
	}

	return args;
}

/**
 * Normalize a project path for the -projectPath argument.
 * Remove trailing slashes/backslashes (Windows can't end with single backslash).
 */
function normalizeProjectPath(path: string): string {
	// Remove trailing slashes/backslashes, but keep root like "C:\"
	const trimmed = path.replace(/[\\/]+$/, "");
	return trimmed || path;
}

/**
 * Read the last N lines of a log file (for progress updates).
 */
function readLogTail(logPath: string, lineCount: number): string | null {
	if (!existsSync(logPath)) return null;
	try {
		const content = readFileSync(logPath, "utf-8");
		const lines = content.split("\n");
		return lines.slice(-lineCount).join("\n");
	} catch {
		return null;
	}
}

/**
 * Read full log content safely.
 */
function readLogContent(logPath: string): string {
	if (!existsSync(logPath)) return "";
	try {
		return readFileSync(logPath, "utf-8");
	} catch {
		return "";
	}
}

function tailText(text: string, lineCount: number): string {
	const lines = text.split("\n");
	if (lines.length <= lineCount) return text;
	return lines.slice(-lineCount).join("\n");
}
