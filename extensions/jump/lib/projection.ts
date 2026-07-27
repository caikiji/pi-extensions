/**
 * Projection — the heart of the jump. Rewrites the physical message
 * list into what the LLM should see when an active jump folds context away.
 *
 * When an active jump exists (jumpNode, id = activeJumpId), the LLM view is:
 *
 *   [ ...messages up to & including TARGET's ToolResult ]   <- stable prefix,
 *                                                           contains the target
 *                                                           label id the model
 *                                                           can re-jump to
 *   [ jumpNode's own ToolResult, re-injected ]           <- carries branch_id=id2,
 *                                                           so model can re-visit
 *                                                           the point it left
 *   [ synthesized payload user message ]                 <- note/payload/jumped_from,
 *                                                           deterministic text
 *   [ ...messages physically after the jump's toolResult ] <- new user input /
 *                                                           post-jump turns, KEPT
 *                                                           so the model can act
 *                                                           on new input
 *
 * Everything physically BETWEEN the target and the jump's own toolResult
 * (the abandoned work) is hidden. The jump result + payload are re-injected
 * synthetically (not sliced from the physical array) so their content is
 * stable even if the physical copy later moves.
 *
 * Invariant: the projected prefix up to & including the target's ToolResult
 * is byte-stable across turns → KV cache hits.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { GraphState } from "./state.ts";
import type { GraphNode } from "./types.ts";

/** Project the physical message list into what the LLM should see. Reads
 *  activeJumpId from state; if no jump is active (or the target anchor is
 *  unresolved), returns the messages unchanged (passthrough). */
export function project(state: GraphState, messages: AgentMessage[]): AgentMessage[] {
  if (!state.activeJumpId) return messages;

  const jumpNode = state.nodes.get(state.activeJumpId);
  if (!jumpNode || jumpNode.kind !== "jump" || !jumpNode.jumpedFrom) {
    // Not a jump node (or stale) — clear and pass through.
    state.activeJumpId = null;
    return messages;
  }

  const target = state.nodes.get(jumpNode.jumpedFrom);
  if (!target || target.anchorIndex < 0 || target.anchorIndex >= messages.length) {
    // Target anchor not resolved yet / out of range — passthrough (safe).
    // The next `context` event will re-resolve anchors by toolCallId.
    return messages;
  }

  const prefix = messages.slice(0, target.anchorIndex + 1);

  // Re-inject the jump's own result deterministically. We do NOT slice it
  // from `messages` (it sits in the abandoned region and may move); we
  // reconstruct a stable copy so the prefix never drifts.
  // timestamp: 0 keeps this synthetic message byte-stable across turns so
  // the KV cache prefix does not invalidate on re-projection. Message order
  // in pi is determined by array position, not timestamp, so this is safe.
  const jumpResultMessage: AgentMessage = {
    role: "toolResult",
    toolCallId: jumpNode.id,
    toolName: "jump",
    content: [
      {
        type: "text",
        text: synthesizeJumpResultText(jumpNode),
      },
    ],
    isError: false,
    timestamp: 0, // stable
  } as AgentMessage;

  const payloadMessage: AgentMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: synthesizePayloadText(jumpNode),
      },
    ],
    timestamp: 0, // stable
  } as AgentMessage;

  // Everything AFTER the jump's physical toolResult (new user messages, new
  // assistant turns, new tool results generated post-jump) is KEPT —
  // otherwise the model could never see new user input after a jump, and
  // would loop on the same report.
  const tailStart = jumpNode.anchorIndex + 1;
  const tail = tailStart < messages.length ? messages.slice(tailStart) : [];

  return [...prefix, jumpResultMessage, payloadMessage, ...tail];
}

/** The deterministic text re-injected as the jump's own ToolResult. Must stay
 *  byte-stable so the KV cache prefix does not invalidate. */
export function synthesizeJumpResultText(node: GraphNode): string {
  const lines: string[] = [];
  lines.push(
    `You called jump(targetId=${node.jumpedFrom}) and it completed. This tool result is YOUR action.`,
  );
  lines.push(
    `New branch node created at the point you jumped from: \`${node.id}\` — jump to it later to recover everything folded away now.`,
  );
  if (typeof node.foldedCount === "number" && node.foldedCount > 0) {
    lines.push(
      `Folded away: ${node.foldedCount} message(s) from your view (recoverable via jump to \`${node.id}\` or label_peek).`,
    );
  }
  return lines.join("\n");
}

/** The deterministic text re-injected as the post-jump payload user message.
 *  Reminds the model that the fold is intentional and points at recovery
 *  options (jump to the branch id, or label_peek). */
export function synthesizePayloadText(node: GraphNode): string {
  const lines: string[] = [];
  lines.push(
    `[This is the post-jump state, resulting from YOUR jump call above. Not a system injection. The procedure was NOT skipped.]`,
  );
  lines.push(
    `You jumped back to branch root \`${node.jumpedFrom}\`. Everything that happened AFTER that anchor and BEFORE your jump — your tool calls and their outputs, your intermediate reasoning, AND any user messages sent during that span — has been folded out of your view. This is the intended effect of jump, not a missing step.`,
  );
  lines.push(
    `Your memory of that span now lives only in the payload below. If it is incomplete, jump to branch \`${node.id}\` or use label_peek to recover the folded detail.`,
  );
  if (node.note) {
    lines.push(``);
    lines.push(`Your carried payload:`);
    lines.push(node.note);
  }
  lines.push(``);
  lines.push(
    `Continue from here. The stable prefix above + your payload is your full working context.`,
  );
  return lines.join("\n");
}
