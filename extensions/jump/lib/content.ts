/**
 * Pure content helpers: message text extraction, token estimation, and
 * branch-preview construction. These have no state and no side effects, so
 * they live in their own module and are imported by tools + projection.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CHARS_PER_TOKEN, PREVIEW_MAX } from "./types.ts";

/** Extract a flat text snapshot from a message's content for previews/peeks.
 *  Handles string content, TextContent parts, and ToolCall parts. Returns
 *  empty string for messages with no textual content. */
export function messageToText(msg: AgentMessage): string {
  const m = msg as {
    role?: string;
    content?: string | unknown[];
    toolCallId?: string;
    toolName?: string;
  };
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  const parts: string[] = [];
  for (const part of m.content) {
    const p = part as { type?: string; text?: string; name?: string; input?: unknown };
    if (p && p.type === "text" && typeof p.text === "string") {
      parts.push(p.text);
    } else if (p && p.type === "tool_call" && typeof p.name === "string") {
      parts.push(`[tool_call: ${p.name}]`);
    }
  }
  return parts.join(" ");
}

/** Rough token estimate for a single message, matching pi's chars/4 heuristic.
 *  Used to estimate the FOLDED region size (the only place we estimate, since
 *  pi's getContextUsage() already gives an accurate physical count). Counts
 *  text content + tool_call names/args + thinking text. */
export function estimateMessageTokens(msg: AgentMessage): number {
  const m = msg as {
    role?: string;
    content?: string | unknown[];
  };
  let chars = 0;
  if (typeof m.content === "string") {
    chars += m.content.length;
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      const p = part as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
      if (!p) continue;
      if (typeof p.text === "string") chars += p.text.length;
      else if (typeof p.thinking === "string") chars += p.thinking.length;
      else if (typeof p.name === "string") {
        chars += p.name.length;
        try {
          chars += JSON.stringify(p.arguments ?? {}).length;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Sum of estimateMessageTokens over an array. Used on the folded region to
 *  give the model a number that reflects how much a jump hid. */
export function estimateArrayTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/** Compose a short preview of the physical messages in [start, end). Used to
 *  annotate jump branch nodes so label_list can show what each branch holds.
 *  Truncates to PREVIEW_MAX chars. */
export function buildPreview(messages: AgentMessage[], startIdx: number, endIdx: number): string {
  if (startIdx < 0) startIdx = 0;
  if (endIdx > messages.length) endIdx = messages.length;
  if (endIdx <= startIdx) return "";
  const lines: string[] = [];
  let len = 0;
  for (let i = startIdx; i < endIdx && len < PREVIEW_MAX; i++) {
    const msg = messages[i];
    const role = (msg as { role?: string }).role ?? "?";
    const text = messageToText(msg).trim();
    if (!text) continue;
    const line = `${role}: ${text}`;
    lines.push(line);
    len += line.length + 1;
  }
  let joined = lines.join("\n");
  if (joined.length > PREVIEW_MAX) {
    joined = joined.slice(0, PREVIEW_MAX - 1) + "…";
  }
  return joined;
}

/** Collapse whitespace and truncate to `max` chars with an ellipsis. */
export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
