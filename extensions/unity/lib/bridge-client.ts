/**
 * Client for talking to a running PiBridge instance inside Unity Editor.
 *
 * PiBridge is a C# HTTP server (see PiBridge.cs) that runs inside an already-open
 * Unity Editor project. It lets external processes execute commands (refresh,
 * compile, run-menu, etc.) in that running instance — avoiding the cost of
 * launching a second Unity process via batchmode.
 *
 * Discovery:
 *   1. Read <projectPath>/Temp/pi-bridge-port (written by PiBridge on startup)
 *   2. Fallback: probe default ports 17841..17860
 *
 * Throttling note:
 *   Unity throttles EditorApplication.update/delayCall when the Editor window
 *   is unfocused, so main-thread dispatch can have second-level latency. The
 *   bridge caps wait at 120s; this client adds its own timeout on top.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_PORT = 17841;
export const MAX_PORT_PROBE = 20;
export const PORT_FILE = "pi-bridge-port";

/**
 * Minimum PiBridge.cs version this client requires. Bump when the C# bridge
 * gains a required command or field. If a running bridge reports a lower
 * version, discoverBridge returns available=false with versionMismatch set,
 * so the caller can tell the user to reinstall via unity_install_bridge.
 */
export const MIN_BRIDGE_VERSION = "0.2.1";

/**
 * Compare semver-like version strings ("0.2.0" < "0.10.0"). Returns true if
 * `actual` is greater than or equal to `minimum`.
 */
export function isBridgeVersionAtLeast(actual: string, minimum: string): boolean {
	const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const a = parse(actual);
	const m = parse(minimum);
	for (let i = 0; i < Math.max(a.length, m.length); i++) {
		const ai = a[i] ?? 0;
		const mi = m[i] ?? 0;
		if (ai !== mi) return ai > mi;
	}
	return true;
}

export interface BridgeResponse<T = unknown> {
	ok: boolean;
	result?: T;
	error?: string;
	durationMs: number;
}

export interface BridgeInfo {
	available: boolean;
	port?: number;
	url?: string;
	version?: string;
	unityVersion?: string;
	projectPath?: string;
	reason?: string; // why unavailable
	versionMismatch?: { running: string; required: string }; // present when bridge is too old
}

/**
 * Discover whether a PiBridge is running for the given project.
 * Tries the port file first, then probes default ports.
 */
export async function discoverBridge(projectPath: string): Promise<BridgeInfo> {
	// 1. Try port file
	const portFile = join(projectPath, "Temp", PORT_FILE);
	let port: number | undefined;
	if (existsSync(portFile)) {
		try {
			port = Number.parseInt(readFileSync(portFile, "utf-8").trim(), 10);
		} catch {
			// fall through to probing
		}
	}

	// 2. If we have a port from file, ping to confirm it's alive
	if (port && Number.isFinite(port)) {
		const info = await pingBridge(port);
		if (info.available) return info;
	}

	// 3. Probe default ports
	for (let p = DEFAULT_PORT; p < DEFAULT_PORT + MAX_PORT_PROBE; p++) {
		const info = await pingBridge(p);
		if (info.available) return info;
	}

	return {
		available: false,
		reason: "PiBridge not running. Place PiBridge.cs in Assets/Editor/ and ensure Unity is open.",
	};
}

/**
 * Ping a bridge at a specific port to confirm it's alive and get its info.
 */
async function pingBridge(port: number): Promise<BridgeInfo> {
	try {
		const res = await sendRaw<{ version: string; unityVersion: string; projectPath: string }>(port, "ping", {});
		if (res.ok && res.result) {
			const runningVersion = res.result.version ?? "0.0.0";
			// Reject bridges older than the client requires. The user should reinstall
			// PiBridge.cs (via unity_install_bridge) to pick up new commands/fields.
			if (!isBridgeVersionAtLeast(runningVersion, MIN_BRIDGE_VERSION)) {
				return {
					available: false,
					port,
					version: runningVersion,
					versionMismatch: { running: runningVersion, required: MIN_BRIDGE_VERSION },
					reason: `PiBridge.cs v${runningVersion} is too old (requires v${MIN_BRIDGE_VERSION}+). ` +
						"Run unity_install_bridge to update PiBridge.cs in this project, then retry.",
				};
			}
			return {
				available: true,
				port,
				url: `http://127.0.0.1:${port}`,
				version: runningVersion,
				unityVersion: res.result.unityVersion,
				projectPath: res.result.projectPath,
			};
		}
		return { available: false, port, reason: res.error ?? "ping failed" };
	} catch (err) {
		return { available: false, port, reason: (err as Error).message };
	}
}

/**
 * Send a command to the bridge and wait for the result.
 *
 * @param port  Bridge port
 * @param command  Command name (e.g. "refresh", "compile", "run-menu")
 * @param args  Arguments object (sent as JSON body)
 * @param timeoutMs  Total timeout (default 60s; bridge itself caps at 120s)
 */
export async function sendCommand<T = unknown>(
	port: number,
	command: string,
	args: Record<string, unknown> = {},
	timeoutMs = 60000,
): Promise<BridgeResponse<T>> {
	return sendRaw<T>(port, command, args, timeoutMs);
}

/**
 * Low-level HTTP POST to the bridge.
 */
async function sendRaw<T>(
	port: number,
	command: string,
	args: Record<string, unknown>,
	timeoutMs = 60000,
): Promise<BridgeResponse<T>> {
	const url = `http://127.0.0.1:${port}/${command}`;
	const body = JSON.stringify(args ?? {});

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal: controller.signal,
		});

		if (!response.ok) {
			return {
				ok: false,
				error: `HTTP ${response.status} ${response.statusText}`,
				durationMs: 0,
			};
		}

		const text = await response.text();
		try {
			return JSON.parse(text) as BridgeResponse<T>;
		} catch {
			return { ok: false, error: `Invalid JSON response: ${text.slice(0, 200)}`, durationMs: 0 };
		}
	} catch (err) {
		const e = err as Error;
		if (e.name === "AbortError") {
			return {
				ok: false,
				error: `Timed out after ${timeoutMs / 1000}s. The Editor may be unfocused (main-thread dispatch is throttled) or busy.`,
				durationMs: timeoutMs,
			};
		}
		// Connection refused etc. means bridge isn't running on this port
		return { ok: false, error: `Cannot connect to bridge: ${e.message}`, durationMs: 0 };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Wait for a condition to become true, polling the bridge.
 * Useful for "trigger compile, then poll status until isCompiling=false".
 */
export async function waitForCondition(
	port: number,
	check: (response: BridgeResponse) => boolean,
	options: { intervalMs?: number; timeoutMs?: number; command?: string; args?: Record<string, unknown> } = {},
): Promise<BridgeResponse> {
	const interval = options.intervalMs ?? 1000;
	const timeout = options.timeoutMs ?? 60000;
	const command = options.command ?? "status";
	const args = options.args ?? {};
	const start = Date.now();

	while (Date.now() - start < timeout) {
		const res = await sendRaw(port, command, args, 10000);
		if (res.ok && check(res)) return res;
		await new Promise((r) => setTimeout(r, interval));
	}

	return {
		ok: false,
		error: `Condition not met within ${timeout / 1000}s`,
		durationMs: Date.now() - start,
	};
}
