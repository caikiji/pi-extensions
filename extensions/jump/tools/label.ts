/**
 * label tool — mark the current point as a navigable graph node.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GraphState } from "../lib/state.ts";
import { COMMON_ANTI_PATTERN_SNIPPET, LABEL_GUIDELINES } from "../lib/guidance.ts";
import { PAYLOAD_MAX, type GraphNode } from "../lib/types.ts";
import { capText } from "../lib/content.ts";

export function registerLabel(pi: ExtensionAPI, state: GraphState): void {
  pi.registerTool({
    name: "label",
    label: "Label",
    description: `Use before starting a long exploratory sub-task whose intermediate steps you won't need afterward (large searches, multi-file reads, trial-and-error). Creates a stable \`id\` you later \`jump\` back to, folding away everything added in between. The label stays in context permanently as a re-entry point; the \`note\` is the plan-end that a later jump's \`payload\` contrasts against.`,
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
      const note = params.note ? capText(params.note, PAYLOAD_MAX) : params.note;
      const node: GraphNode = {
        id: toolCallId,
        kind: "label",
        anchorIndex: -1, // resolved lazily
        note,
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
              (note ? "\nnote: " + note : "") +
              "\nUse `jump` with this id to return here and pop everything added since.",
          },
        ],
        details: { id: toolCallId, note },
      };
    },
  });
}
