/**
 * jump tool — fold context back to a previously created label/jump node,
 * carrying a payload that contrasts with the target's plan-note.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GraphState } from "../lib/state.ts";
import { COMMON_ANTI_PATTERN_SNIPPET, JUMP_GUIDELINES } from "../lib/guidance.ts";
import { buildPreview, capText } from "../lib/content.ts";
import { synthesizeJumpResultText } from "../lib/projection.ts";
import { PAYLOAD_MAX, type GraphNode } from "../lib/types.ts";

export function registerJump(pi: ExtensionAPI, state: GraphState): void {
  pi.registerTool({
    name: "jump",
    label: "Jump",
    description: `Use when a sub-task is done and you want to return to an earlier \`label\`, folding the work in between out of view. Pops everything after the target from the LLM view and injects your carried \`payload\` in its place. Auto-labels the point you jumped FROM as a new branch \`id\` (re-visit it later to recover the folded work). The fold lasts exactly one LLM turn, then the full context auto-restores.`,
    promptSnippet: COMMON_ANTI_PATTERN_SNIPPET,
    promptGuidelines: JUMP_GUIDELINES,
    parameters: Type.Object({
      targetId: Type.String({
        description: "The id of the label or jump node to return to. Use label_list to enumerate valid ids.",
      }),
      payload: Type.Optional(
        Type.String({
          description:
            "What you actually did, AND how it differs from the target label's note (the plan): completed / not-done / new-beyond-plan. This contrast is what lets the post-jump you reconstruct reality rather than assuming the plan held.",
        }),
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      // Guard: reject self-jump (jumping to this very call's id). It would
      // create a node whose jumpedFrom is itself, producing a degenerate
      // projection. The toolCallId isn't known to the model ahead of time,
      // but a confused model could pass a stale id that happens to match.
      if (params.targetId === toolCallId) {
        return {
          content: [
            {
              type: "text",
              text: `Refusing self-jump: targetId ${params.targetId} is this very jump call. Pick a different label/jump id.`,
            },
          ],
          isError: true,
          details: { jumped: false, reason: "self_jump" },
        };
      }

      const target = state.nodes.get(params.targetId);
      if (!target) {
        // Unknown target: do NOT mutate activeJumpId. If a previous jump was
        // active, leave it as-is (the model is still in that folded view and
        // can recover by jumping to a valid id). Clearing here would silently
        // unfold the context with no explanation.
        return {
          content: [
            {
              type: "text",
              text: `Unknown id: ${params.targetId}. No jump performed. Use label_list to see valid ids.`,
            },
          ],
          isError: true,
          details: { jumped: false, reason: "unknown_id" },
        };
      }

      // Capture a preview of the region that will be folded away (everything
      // physically between the target's anchor and this jump's own result,
      // which isn't in the array yet — so we fold [target.anchorIndex+1, end)).
      // We use the cached lastMessages from the context event. Best-effort: if
      // messages aren't available yet, the preview is simply empty.
      let preview = "";
      let foldedCount = 0;
      if (state.lastMessages && target.anchorIndex >= 0) {
        const start = target.anchorIndex + 1;
        const end = state.lastMessages.length;
        if (end > start) {
          foldedCount = end - start;
          preview = buildPreview(state.lastMessages, start, end);
        }
      }

      // 1. Auto-label the current point as a new jump node. Its anchor is the
      //    jump tool's OWN result message (this call). It records where we
      //    jumped from so the model can re-visit the branch it just left.
      const jumpNode: GraphNode = {
        id: toolCallId,
        kind: "jump",
        anchorIndex: -1, // resolved lazily on next projection
        note: params.payload ? capText(params.payload, PAYLOAD_MAX) : params.payload,
        jumpedFrom: params.targetId,
        preview: preview || undefined,
        foldedCount: foldedCount > 0 ? foldedCount : undefined,
        createdAt: Date.now(),
      };
      state.nodes.set(toolCallId, jumpNode);

      // 2. Activate the jump: projection will hide everything after the jump
      //    node's own result and inject the payload. Cleared on agent_settled.
      state.activeJumpId = toolCallId;

      state.maybePrune();
      state.persist(pi);

      // The physical tool result text is the same deterministic string the
      // projection re-injects, so the LLM never sees a discrepancy between
      // the real result and the synthesized one. We do NOT re-append the
      // payload or a folded-count echo here: both are already part of
      // synthesizeJumpResultText / synthesizePayloadText (which projection
      // re-injects next turn), and the payload is the model's own input —
      // re-echoing it in the result would just burn tokens.
      const resultText = synthesizeJumpResultText(jumpNode);

      return {
        content: [{ type: "text", text: resultText }],
        details: {
          jumped: true,
          branchId: toolCallId,
          targetId: params.targetId,
          foldedCount: foldedCount > 0 ? foldedCount : 0,
        },
      };
    },
  });
}
