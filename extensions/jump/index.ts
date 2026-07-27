/**
 * jump — turn the linear context into a navigable graph the agent
 * maintains itself, while keeping the physical session linear so prompt-cache
 * prefixes stay byte-stable.
 *
 * Core idea (DO NOT deviate):
 *   - Physical SessionManager stays append-only & linear.
 *   - The "graph" lives in extension memory + a `context` projection.
 *   - Each `label`/`jump` call returns a stable id (the toolCallId) that the
 *     model can later jump back to. Jumping re-projects the message array seen
 *     by the LLM to `[...stable-prefix, <jump-result-id>, <payload>]`, popping
 *     (hiding) everything after the anchor — so the work in between is dropped
 *     from the LLM view and its cache is invalidated, exactly as intended.
 *   - Jumping always auto-labels the current point first and injects the new
 *     branch id into the carried payload, so every jump target is itself a
 *     node you can re-visit later.
 *
 * Projection semantics (fixed):
 *   - A jump folds the context for EXACTLY ONE LLM call (the turn immediately
 *     after the jump tool call). Once that turn settles (agent_settled), the
 *     projection is auto-cleared so the model returns to the full physical
 *     context. To re-fold, jump again. This prevents the "activeJumpId sticks
 *     forever" bug where every subsequent turn stayed collapsed.
 *
 * Compaction policy (fixed):
 *   - We do NOT unconditionally cancel compaction — that caused an overflow
 *     retry death-loop (cancel -> retry -> same size -> overflow -> cancel...).
 *   - We let compaction proceed, but persist graph state as a custom entry
 *     that survives compaction, and re-resolve anchors by toolCallId after
 *     compaction rewrites the message array. If a jump target's anchor was
 *     summarized away, the jump gracefully no-ops (passthrough).
 *
 * Module layout (mirrors the `unity` extension's directory convention):
 *   lib/types.ts      — GraphNode, PersistedState, constants
 *   lib/state.ts      — GraphState (shared mutable state + persist/prune/resolve)
 *   lib/content.ts    — message text extraction, token estimation, previews
 *   lib/metrics.ts    — context-metrics report (window/physical/in-view/↑↓R CH)
 *   lib/projection.ts — project() + synthesized jump/payload text
 *   lib/guidance.ts   — promptSnippet/promptGuidelines text
 *   tools/label.ts        — label tool
 *   tools/jump.ts         — jump tool
 *   tools/label-list.ts   — label_list tool (anchors + metrics)
 *   tools/label-peek.ts   — label_peek tool (read folded content)
 *   index.ts          — entry: instantiate state, bind events, register tools
 *
 * Not a public API; prototype. Persistence via pi.appendEntry (CustomEntry,
 * not sent to LLM). State rebuilt on session_start from getBranch().
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GraphState } from "./lib/state.ts";
import { project } from "./lib/projection.ts";
import { estimateArrayTokens } from "./lib/content.ts";
import { registerLabel } from "./tools/label.ts";
import { registerJump } from "./tools/jump.ts";
import { registerLabelList } from "./tools/label-list.ts";
import { registerLabelPeek } from "./tools/label-peek.ts";

export default function jump(pi: ExtensionAPI) {
  const state = new GraphState();

  // ---- events ----

  // Projection: rewrite messages before each LLM call. Single handler so
  // anchor-resolution, message caching, folded-estimate, and projection share
  // one pass. Nodes are created with anchorIndex = -1 because their
  // ToolResultMessage isn't in `messages` yet at execute() time; we resolve
  // lazily here.
  pi.on("context", async (event) => {
    // Cache the live message array so tools (label_list / label_peek / preview
    // generation) can read folded content. Best-effort; tools degrade if null.
    state.lastMessages = event.messages;

    if (state.resolveAnchors(event.messages)) {
      state.persist(pi); // best-effort anchor persistence
    }

    const projected = project(state, event.messages);

    // Compute the in-view token estimate ONLY when a jump is actively folding.
    // Rationale: pi's getContextUsage().tokens already gives an accurate
    // physical count (it uses real provider usage + trailing chars/4 estimate).
    // We can't replicate that without internal APIs, so when there's NO fold
    // we leave lastFoldedEstimate=null (buildContextReport then reports
    // in-view == physical). When a fold IS active, physical counts the full
    // array but the model only sees the projected (folded) array — so we
    // estimate JUST the folded region with chars/4 and subtract from physical.
    // This keeps the error bounded to the small folded region instead of the
    // whole array.
    if (state.activeJumpId) {
      const jumpNode = state.nodes.get(state.activeJumpId);
      const target = jumpNode?.jumpedFrom ? state.nodes.get(jumpNode.jumpedFrom) : undefined;
      if (jumpNode && target && target.anchorIndex >= 0 && jumpNode.anchorIndex >= 0) {
        const folded = event.messages.slice(target.anchorIndex + 1, jumpNode.anchorIndex);
        state.lastFoldedEstimate = estimateArrayTokens(folded);
      } else {
        state.lastFoldedEstimate = null;
      }
    } else {
      state.lastFoldedEstimate = null;
    }
    return { messages: projected };
  });

  // Auto-clear the active jump once the agent has settled (no more automatic
  // retry/compaction/continuation). This makes a jump fold the context for
  // exactly ONE LLM call — the turn right after the jump tool call. After
  // that turn the model returns to the full physical context. To re-fold,
  // jump again. This fixes the "activeJumpId sticks forever" bug.
  //
  // We use agent_settled (not turn_end) because a jump turn may be followed by
  // an automatic tool-use continuation within the same agent loop, and we want
  // the fold to remain in effect for that immediate continuation too.
  pi.on("agent_settled", async () => {
    if (state.activeJumpId !== null) {
      state.activeJumpId = null;
      state.persist(pi);
    }
  });

  // Accumulate provider-reported usage from tool_result events. This is the
  // authoritative source for the footer's ↑↓R CH numbers (input/output/
  // cacheRead/cacheWrite). We sum across the session so the model gets a
  // "how much have I spent / how cache-friendly am I" sense. (message_end
  // also carries usage, but tool_result fires per tool call and is the more
  // granular signal; either way, summing per-occurrence matches pi's own
  // session-stats aggregation.)
  pi.on("tool_result", async (event) => {
    state.accumulateUsage(event.usage);
  });

  // Compaction policy (fixed): do NOT unconditionally cancel.
  //
  // Previously this returned { cancel: true } unconditionally, which caused an
  // overflow-retry death-loop: cancel -> retry the aborted turn -> same
  // context size -> overflow again -> cancel ... forever.
  //
  // Now we ALLOW compaction. Our graph state is persisted via CustomEntry
  // (which compaction preserves), and anchors are re-resolved by toolCallId
  // on the next `context` event. If a jump target's physical anchor was
  // summarized away, project() gracefully passthrough-returns the full
  // (compacted) context instead of folding to a missing anchor — so a lost
  // anchor degrades to "no fold" rather than crashing.
  //
  // We intentionally return void (no cancel) so pi proceeds normally.

  // Restore state on (re)start / resume / fork.
  pi.on("session_start", async (_event, ctx) => {
    // getBranch() = path from root to current leaf.
    state.reset(ctx.sessionManager.getBranch() as { type: string; customType?: string; data?: unknown }[]);
  });

  // ---- tools ----

  registerLabel(pi, state);
  registerJump(pi, state);
  registerLabelList(pi, state);
  registerLabelPeek(pi, state);
}
