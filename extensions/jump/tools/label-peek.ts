/**
 * label_peek tool — read a bounded slice of a jump branch's folded content
 * WITHOUT jumping or changing the context projection. Read-only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GraphState } from "../lib/state.ts";
import { messageToText } from "../lib/content.ts";
import { PEEK_MAX } from "../lib/types.ts";

export function registerLabelPeek(pi: ExtensionAPI, state: GraphState): void {
  pi.registerTool({
    name: "label_peek",
    label: "Peek at a branch",
    description: `Returns a bounded slice of a jump branch's FOLDED content without jumping or changing the context projection. Lets you recover a detail that was folded away after a \`jump\`, or preview a branch before deciding whether to jump into it. Only jump nodes have foldable content; labels return their note. Read-only.`,
    promptSnippet:
      "label_peek: read a folded branch's content without jumping. Use it when, after a jump, your payload is missing a detail you folded away — cheaper than jumping to the branch and back.",
    parameters: Type.Object({
      id: Type.String({
        description: "The id of the jump branch node to peek at (from label_list).",
      }),
      maxChars: Type.Optional(
        Type.Integer({
          description: `Max chars of folded content to return. Defaults to ${PEEK_MAX}.`,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const node = state.nodes.get(params.id);
      if (!node) {
        return {
          content: [{ type: "text", text: `Unknown id: ${params.id}. Use label_list to see valid ids.` }],
          isError: true,
          details: { peeked: false, reason: "unknown_id" },
        };
      }

      // Labels have no folded region — return their note directly.
      if (node.kind === "label") {
        return {
          content: [
            {
              type: "text",
              text: `This is a label anchor, not a jump branch — it has no folded content.\nid: ${node.id}\nnote: ${node.note ?? "(no note)"}`,
            },
          ],
          details: { peeked: true, kind: "label" },
        };
      }

      // Jump node: reconstruct the folded region from the cached live messages.
      // The folded region is physically (target.anchorIndex, jumpNode.anchorIndex).
      // Both anchors are re-resolved by toolCallId on each context event; if
      // either is still -1 (not yet resolved, e.g. right after creation before
      // a context event fired, or after compaction moved things), we degrade
      // gracefully and surface the stored preview instead.
      const cap = typeof params.maxChars === "number" && params.maxChars > 0 ? params.maxChars : PEEK_MAX;

      if (state.lastMessages && node.anchorIndex >= 0) {
        const target = node.jumpedFrom ? state.nodes.get(node.jumpedFrom) : undefined;
        const start = target && target.anchorIndex >= 0 ? target.anchorIndex + 1 : 0;
        const end = node.anchorIndex; // exclusive — the jump's own result is NOT folded content
        if (end > start && start >= 0 && end <= state.lastMessages.length) {
          const slice = state.lastMessages.slice(start, end);
          const lines: string[] = [
            `Folded content of branch ${node.id} (${slice.length} message(s), target ${node.jumpedFrom ?? "?"}):`,
            "",
          ];
          let len = 0;
          for (const msg of slice) {
            const role = (msg as { role?: string }).role ?? "?";
            const text = messageToText(msg).trim();
            if (!text) continue;
            const line = `${role}: ${text}`;
            lines.push(line);
            len += line.length + 1;
            if (len >= cap) {
              lines.push("…[truncated; increase maxChars for more]");
              break;
            }
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { peeked: true, kind: "jump", messages: slice.length },
          };
        }
      }

      // Degrade path: anchors not resolvable right now. Surface whatever we
      // stored at jump time so the caller still gets something useful.
      const fallback: string[] = [
        `Folded content of branch ${node.id} is not resolvable from the live context right now (anchors not yet resolved, or messages were compacted).`,
      ];
      if (node.preview) {
        fallback.push("", `Stored preview from jump time:`, node.preview);
      } else {
        fallback.push("No stored preview available. Try jumping to this id to recover the detail.");
      }
      return {
        content: [{ type: "text", text: fallback.join("\n") }],
        details: { peeked: false, kind: "jump", reason: "unresolved", foldedCount: node.foldedCount },
      };
    },
  });
}
