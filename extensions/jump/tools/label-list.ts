/**
 * label_list tool — enumerate all anchors + show context metrics. Read-only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GraphState } from "../lib/state.ts";
import { buildContextReport } from "../lib/metrics.ts";
import { truncate } from "../lib/content.ts";

export function registerLabelList(pi: ExtensionAPI, state: GraphState): void {
  pi.registerTool({
    name: "label_list",
    label: "List anchors",
    description: `List all jump anchors (labels and jump branch nodes) you can currently jump to, PLUS a context-metrics block (window / physical / in-view tokens, cumulative ↑↓R CH) so you can gauge how much context room you have. Returns each node's id, kind (label/jump), its note or carried payload, creation order, and — for jump nodes — a short preview of the folded content and how many messages were folded. Use this whenever you've lost track of which anchors exist, what a branch contains, OR how full your context is. Read-only: does NOT change the context projection.`,
    promptSnippet:
      "label_list: enumerate jump anchors + show context metrics (window/physical/in-view tokens). Call BEFORE jump to get a valid id; call when unsure what anchors exist or how full your context is.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      // Context metrics FIRST — the model needs this even when no anchors exist.
      const report = buildContextReport(state, ctx);
      const lines: string[] = [];
      if (report) {
        lines.push(report, "");
      }

      if (state.nodes.size === 0) {
        lines.push("No anchors yet. Use `label` to create one before starting a foldable sub-task.");
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { count: 0 },
        };
      }

      // Newest-last so the most recently created (most likely relevant) nodes
      // appear at the bottom, near the user's eye.
      const ordered = [...state.nodes.values()].sort((a, b) => a.createdAt - b.createdAt);
      lines.push(`Anchors (${ordered.length}):`);
      for (const n of ordered) {
        const age = Math.round((Date.now() - n.createdAt) / 1000);
        const ageStr = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;
        if (n.kind === "label") {
          lines.push("");
          lines.push(`• [label] ${n.id}  (${ageStr})`);
          lines.push(`    note: ${n.note ?? "(no note)"}`);
        } else {
          lines.push("");
          lines.push(`• [jump→${n.jumpedFrom ?? "?"}] ${n.id}  (${ageStr})`);
          if (typeof n.foldedCount === "number") {
            lines.push(`    folded: ${n.foldedCount} message(s)`);
          }
          lines.push(`    payload: ${n.note ? truncate(n.note, 160) : "(no payload)"}`);
          if (n.preview) {
            lines.push(`    preview: ${truncate(n.preview, 160)}`);
          }
        }
      }
      lines.push("");
      lines.push(
        "Jump to any id above with `jump`. To glance at a jump's folded content without jumping, use `label_peek <id>`.",
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: ordered.length,
          ids: ordered.map((n) => n.id),
        },
      };
    },
  });
}
