/**
 * unity_events tool — non-blocking event subscriptions over an SSE stream.
 *
 * The agent subscribes to Unity events (compile_started/compile_done,
 * playmode_entered/playmode_exited) and continues working. When an event
 * fires inside Unity, PiBridge pushes it down a long-lived /events SSE
 * connection; this module's background loop reads it and calls
 * pi.sendMessage() (customType "unity-event") to inject the event into the
 * no blocking wait. This is the pi-unique capability MCP cannot replicate.
 *
 * Lifecycle:
 *   - subscribe: registers server-side filter + ensures the background SSE
 *     loop is running for that project (started once, reused).
 *   - unsubscribe: removes from server-side filter. The loop keeps running
 *     (cheap; server drops unfiltered events before enqueue). Stopping the
 *     loop entirely isn't wired in v1 — it dies when the agent session ends.
 *   - list: reports current server-side subscriptions.
 *
 * Resilience: the SSE loop reconnects on disconnect (Unity domain reload
 * kills the listener thread and may change the port). On each reconnect it
 * re-runs discoverBridge so a changed port is picked up automatically.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverBridge, sendCommand, type BridgeInfo, type BridgeResponse } from "../lib/bridge-client.ts";
import { resolveProjectPath } from "../lib/tool-utils.ts";

export const UNITY_EVENT_TYPES = [
	"compile_started",
	"compile_done",
	"playmode_entered",
	"playmode_exited",
] as const;

export const unityEventsParams = Type.Object({
	action: StringEnum(["subscribe", "unsubscribe", "list"]),
	events: Type.Optional(
		Type.Array(StringEnum(UNITY_EVENT_TYPES), {
			description:
				"Event types to subscribe/unsubscribe. Required for subscribe/unsubscribe. " +
				"compile_done data includes {errors:N}. playmode events have no data.",
		}),
	),
	projectPath: Type.Optional(
		Type.String({ description: "Path to Unity project root. Defaults to auto-detect from cwd." }),
	),
});

export interface UnityEventsParams {
	action: "subscribe" | "unsubscribe" | "list";
	events?: (typeof UNITY_EVENT_TYPES)[number][];
	projectPath?: string;
}

export interface UnityEventsResult {
	projectPath: string;
	bridge: BridgeInfo;
	response: BridgeResponse;
	sseLoop: "running" | "reused" | "not-started";
}

// Module-level SSE state. One loop per project (the common case). If the
// agent subscribes for a different project, the old loop is aborted first.
interface SseState {
	controller: AbortController;
	projectPath: string;
	port: number;
}
let sseState: SseState | null = null;

// Event types the client wants. Persisted across SSE reconnects so the loop
// can re-subscribe after a domain reload wipes the server-side _subs. Without
// this, events fired after a reload would be filtered out server-side.
const desiredSubscriptions = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runUnityEvents(
	params: UnityEventsParams,
	cwd: string,
	pi: ExtensionAPI,
): Promise<UnityEventsResult> {
	const projectPath = resolveProjectPath(params.projectPath, cwd);
	const bridge = await discoverBridge(projectPath);

	if (!bridge.available) {
		return {
			projectPath,
			bridge,
			response: { ok: false, error: bridge.reason ?? "PiBridge not running", durationMs: 0 },
			sseLoop: "not-started",
		};
	}

	const events = params.events ?? [];
	const response = await sendCommand(
		bridge.port!,
		"manage-subscriptions",
		{ action: params.action, events },
		15000,
	);

	// Track desired subscriptions so the SSE loop can re-subscribe after a
	// reconnect (domain reload wipes server-side state).
	if (params.action === "subscribe") {
		for (const e of events) desiredSubscriptions.add(e);
	} else if (params.action === "unsubscribe") {
		for (const e of events) desiredSubscriptions.delete(e);
	}

	let sseLoop: "running" | "reused" | "not-started" = "not-started";

	if (params.action === "subscribe") {
		// If a loop exists for a different project/port (e.g. agent switched
		// projects, or bridge restarted on a new port after domain reload),
		// tear it down and start fresh.
		if (sseState && (sseState.projectPath !== projectPath || sseState.port !== bridge.port)) {
			sseState.controller.abort();
			sseState = null;
		}
		if (!sseState) {
			const controller = new AbortController();
			sseState = { controller, projectPath, port: bridge.port! };
			// Fire and forget — the loop outlives this tool call.
			void startSseLoop(pi, projectPath, controller.signal);
			sseLoop = "running";
		} else {
			sseLoop = "reused";
		}
	}

	return { projectPath, bridge, response, sseLoop };
}

/**
 * Background SSE loop. Reconnects on disconnect (domain reload, port change,
 * transient error). Exits only when the abort signal fires.
 *
 * On each event, calls pi.sendMessage (customType "unity-event") with
 * agent is notified without interrupting an in-flight turn (the message
 * queues and triggers a turn once the agent is idle, or immediately if idle).
 */
async function startSseLoop(pi: ExtensionAPI, projectPath: string, signal: AbortSignal): Promise<void> {
	while (!signal.aborted) {
		let port: number;
		try {
			const bridge = await discoverBridge(projectPath);
			if (!bridge.available || !bridge.port) {
				await sleep(1000);
				continue;
			}
			port = bridge.port;
		} catch {
			await sleep(1000);
			continue;
		}

		// Re-subscribe on every (re)connect: a Unity domain reload wipes the
		// server-side _subs, so without this the server would filter out all
		// events after the first reload. Best-effort — ignore failures.
		if (desiredSubscriptions.size > 0) {
			try {
				await sendCommand(port, "manage-subscriptions", { action: "subscribe", events: [...desiredSubscriptions] }, 10000);
			} catch {
				// non-fatal; events may be missed this cycle, loop will retry next reconnect
			}
		}

		try {
			const resp = await fetch(`http://127.0.0.1:${port}/events`, { signal });
			if (!resp.ok || !resp.body) {
				await sleep(1000);
				continue;
			}

			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (!signal.aborted) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				// SSE events are separated by a blank line. Parse complete blocks.
				let sep: number;
				while ((sep = buffer.indexOf("\n\n")) >= 0) {
					const block = buffer.slice(0, sep);
					buffer = buffer.slice(sep + 2);
					const ev = parseSseBlock(block);
					if (!ev) continue;
					const dataStr = ev.data && ev.data !== "{}" ? ` ${ev.data}` : "";
					// Deliver as a custom message (customType: "unity-event") so the TUI
					// can render it distinctly from user-typed messages (see the
					// registerMessageRenderer in index.ts). It still participates in
					// LLM context, so the agent is notified.
					//
					// Async-lag note: SSE delivery is realtime, but followUp queues the
					// message until the agent is idle — so by the time the agent sees
					// this, the event may already be stale (e.g. the agent may already
					// have learned about compile completion via unity_status/waitForBridge).
					// The content flags this so the agent treats it as a hint, not
					// authoritative state.
					try {
						await pi.sendMessage({
							customType: "unity-event",
							content: `Unity ${ev.event}${dataStr} (async notification — may lag; verify with unity_status/unity_log if actionable).`,
							display: true,
							details: { event: ev.event, data: ev.data },
						}, { deliverAs: "followUp", triggerTurn: true });
					} catch {
						// sendMessage failing shouldn't kill the loop.
					}
				}
			}
		} catch (err) {
			if (signal.aborted) return;
			// Disconnect (domain reload killed the bridge, network blip, etc.).
			// Back off then reconnect — discoverBridge on the next loop will pick
			// up any new port written by the restarted bridge.
			await sleep(1000);
		}
	}
}

interface SseEvent {
	event: string;
	data?: string;
}

// Parse one SSE block (lines between blank-line separators) into {event, data}.
// Lines starting with ":" are comments (heartbeats) and are ignored.
function parseSseBlock(block: string): SseEvent | null {
	let event: string | undefined;
	let data: string | undefined;
	for (const line of block.split("\n")) {
		if (line.startsWith(":")) continue; // comment / heartbeat
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) data = line.slice(5).trim();
	}
	if (!event) return null;
	return { event, data };
}
