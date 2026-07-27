/**
 * label tool — mark the current point as a navigable graph node.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GraphState } from "../lib/state.ts";
import { COMMON_ANTI_PATTERN_SNIPPET, LABEL_GUIDELINES } from "../lib/guidance.ts";
import type { GraphNode } from "../lib/types.ts";

export function registerLabel(pi: ExtensionAPI, state: GraphState): void {
  pi.registerTool({
    name: "label",
    label: "Label",
    description: `Mark the current point in the conversation as a navigable graph node. Returns a stable \`id\` you can later jump back to with the \`jump\` tool. Use this right before starting work whose intermediate steps you do NOT need to keep in context, so you can collapse it later. The label itself stays in context permanently as a cache-stable anchor. IMPORTANT: the \`note\` is not optional decoration — it is the anchor's purpose. After a jump, the work between this label and the jump is folded out of view; your \`note\` here and your \`payload\` in the later jump are the two ends of the thread that let you reconstruct what happened. Write the note as: WHY you are placing this label now + WHAT you plan to do next. A vague note like 'checkpoint' leaves you unable to explain the gap after a jump. Use \`label_list\` to see all existing anchors.`,
    promptSnippet: COMMON_ANTI_PATTERN_SNIPPET,
    promptGuidelines: LABEL_GUIDELINES,
    parameters: Type.Object({
      note: Type.Optional(
        Type.String({
          description:
            "Why this label is placed now + what you plan to do next. Example: 'investigating auth bug in src/auth.ts — will explore 2-3 files then jump back with findings'. This note stays in the stable prefix and is visible after any jump to this label, so it anchors the model's understanding of why the folded work existed.",
        }),
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      // The label node is anchored to this very tool's result message, which
      // will be appended right after this execute() returns. We record the
      // id now and resolve the anchor index lazily on first projection.
      const node: GraphNode = {
        id: toolCallId,
        kind: "label",
        anchorIndex: -1, // resolved lazily
        note: params.note,
        createdAt: Date.now(),
      };
      state.nodes.set(toolCallId, node);
      state.maybePrune();
      state.persist(pi);

      return {
        content: [
          {
            type: "text",
            text:
              "Label created.\nid: " +
              toolCallId +
              (params.note ? "\nnote: " + params.note : "") +
              "\nUse `jump` with this id to return here and pop everything added since." +
              "\nTip: a good note states why you placed this label + your next step — it is the plan-end of the thread you'll reconnect after a jump.",
          },
        ],
        details: { id: toolCallId, note: params.note },
      };
    },
  });
}
