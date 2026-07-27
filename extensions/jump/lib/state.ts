/**
 * GraphState — the shared mutable state of the jump, encapsulated so
 * the projection, events, and tools can all operate on one instance without
 * passing a tangle of closures around (the original prototype kept everything
 * in one big function scope).
 *
 * Lifecycle:
 *   - new GraphState() at extension load.
 *   - reset() on session_start (clears runtime state, optionally restores
 *     persisted nodes from the session branch).
 *   - persist(pi) after any mutation that should survive compaction/resume.
 *
 * Runtime-only fields (activeJumpId, lastMessages, cumulativeUsage,
 * lastContextUsage, lastFoldedEstimate) are NOT persisted — they are
 * re-derived or start fresh on (re)start. Only the nodes map is persisted.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
  MAX_NODES,
  PERSIST_TYPE,
  type GraphNode,
  type PersistedState,
} from "./types.ts";

export interface CumulativeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ContextUsageSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export class GraphState {
  /** All graph nodes keyed by their toolCallId. */
  readonly nodes: Map<string, GraphNode> = new Map();
  /** The currently-active jump id, or null when no fold is active. Transient:
   *  cleared on agent_settled and never persisted. */
  activeJumpId: string | null = null;

  /** Most recent message array seen on the `context` event. Tools' execute()
   *  does not receive messages, so we cache the latest here for label_list /
   *  label_peek / preview generation. Best-effort. */
  lastMessages: AgentMessage[] | null = null;

  /** Cumulative provider usage accumulated from tool_result events across the
   *  session. Mirrors the footer's ↑↓R CH numbers. Reset on session_start. */
  cumulativeUsage: CumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  /** Most recent context-usage snapshot from getContextUsage() (physical array
   *  tokens + context window). Updated opportunistically when tools run. */
  lastContextUsage: ContextUsageSnapshot | null = null;

  /** When a jump is actively folding, chars/4 estimate of JUST the folded
   *  region. buildContextReport computes in-view = physical - this. Null when
   *  no fold is active (in-view == physical then). */
  lastFoldedEstimate: number | null = null;

  /** toolCallIds whose usage we have already counted, so overflow-retry or
   *  duplicate tool_result events do not double-count (which would inflate the
   *  cacheHit ratio). Reset on session_start. */
  private seenUsageIds: Set<string> = new Set();

  /** Persist the current nodes map as a CustomEntry. activeJumpId is always
   *  persisted as null so a resumed session starts unfolded. */
  persist(pi: ExtensionAPI): void {
    const state: PersistedState = {
      nodes: Object.fromEntries(this.nodes),
      activeJumpId: null,
    };
    pi.appendEntry<PersistedState>(PERSIST_TYPE, state);
  }

  /** Prune oldest label nodes if the graph exceeds MAX_NODES. Jump nodes are
   *  always retained (they are re-visit targets), as are labels still pointed
   *  to by some jump node's `jumpedFrom` — pruning those would orphan the
   *  jump and make it silently no-op. */
  maybePrune(): void {
    if (this.nodes.size <= MAX_NODES) return;
    const referenced = new Set<string>();
    for (const n of this.nodes.values()) {
      if (n.kind === "jump" && n.jumpedFrom) referenced.add(n.jumpedFrom);
    }
    const labels = [...this.nodes.values()]
      .filter((n) => n.kind === "label" && !referenced.has(n.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    const excess = this.nodes.size - MAX_NODES;
    for (let i = 0; i < excess && i < labels.length; i++) {
      this.nodes.delete(labels[i].id);
    }
  }

  /** Find the index of the ToolResultMessage for a given toolCallId. Reverse
   *  scan so the latest occurrence wins (defensive against duplicate ids after
   *  fork merge). */
  static findToolResultIndex(messages: AgentMessage[], toolCallId: string): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: string; toolCallId?: string };
      if (m.role === "toolResult" && m.toolCallId === toolCallId) return i;
    }
    return -1;
  }

  /** Resolve/refresh anchorIndex for every node against the live message
   *  array. Called from the context event each turn BEFORE project(). Each
   *  node's stored index is VALIDATED: if the message at that index no longer
   *  carries our toolCallId (it shifted due to compaction / fork / resume), it
   *  is treated as stale, reset to -1, and re-resolved by toolCallId. This is
   *  the fix for the compaction-stale-index bug: previously we skipped nodes
   *  whose anchorIndex was already >= 0, so a compaction that rewrote the
   *  array left them pointing at the wrong message forever. Returns true if
   *  any anchor changed (newly resolved or re-resolved after invalidation). */
  resolveAnchors(messages: AgentMessage[]): boolean {
    let mutated = false;
    for (const node of this.nodes.values()) {
      const cur = node.anchorIndex;
      const valid =
        cur >= 0 &&
        cur < messages.length &&
        (messages[cur] as { role?: string; toolCallId?: string }).role === "toolResult" &&
        (messages[cur] as { toolCallId?: string }).toolCallId === node.id;
      if (valid) continue;
      if (cur >= 0) {
        // Stale index (points at the wrong message) — clear and re-resolve.
        node.anchorIndex = -1;
        mutated = true;
      }
      const idx = GraphState.findToolResultIndex(messages, node.id);
      if (idx >= 0) {
        node.anchorIndex = idx;
        mutated = true;
      }
    }
    return mutated;
  }

  /** Mark every node's anchorIndex as stale (-1) so the next `context` event
   *  re-resolves them by toolCallId. Called after compaction rewrites the
   *  physical message array (and safe to call anytime). */
  invalidateAnchors(): void {
    for (const node of this.nodes.values()) node.anchorIndex = -1;
  }

  /** Reset runtime state on session_start, and restore persisted nodes from
   *  the current session branch (if any). anchorIndex is always treated as
   *  stale after restore — it is re-resolved by toolCallId on the next context
   *  event, because physical indices shift across compaction / resume / fork. */
  reset(branch: { type: string; customType?: string; data?: unknown }[]): void {
    this.nodes.clear();
    this.activeJumpId = null;
    this.lastMessages = null;
    this.cumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.seenUsageIds.clear();
    this.lastContextUsage = null;
    this.lastFoldedEstimate = null;

    let last: PersistedState | undefined;
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === PERSIST_TYPE) {
        const data = entry.data as PersistedState | undefined;
        if (data) last = data;
      }
    }
    if (last) {
      for (const [id, node] of Object.entries(last.nodes)) {
        // Always treat persisted anchorIndex as stale; re-resolve by id.
        this.nodes.set(id, { ...node, anchorIndex: -1 });
      }
      // NOTE: we intentionally do NOT restore `activeJumpId`. A non-null
      // activeJumpId means "the context is currently folded to a jump-resume
      // view" — that is a transient runtime state, not something to revive
      // on resume. Reviving it would immediately re-fold the context on the
      // very next `context` event (before the model has a chance to act),
      // which makes label/jump calls appear to auto-trigger a phantom jump.
      // On resume the model starts from the full (unfolded) physical context
      // and may choose to jump again. The persisted nodes are still useful:
      // their ids remain valid jump targets. (activeJumpId was already
      // cleared above; restored nodes already have anchorIndex = -1.)
    }
  }

  /** Accumulate a provider-reported Usage into cumulativeUsage. Called from
   *  tool_result events. De-dupes by toolCallId so overflow-retry / duplicate
   *  tool_result events don't double-count (which would inflate cacheHit).
   *  Mirrors the footer's ↑↓R CH totals. */
  accumulateUsage(toolCallId: string, u: Usage | undefined): void {
    if (!u) return;
    if (this.seenUsageIds.has(toolCallId)) return;
    this.seenUsageIds.add(toolCallId);
    this.cumulativeUsage.input += u.input ?? 0;
    this.cumulativeUsage.output += u.output ?? 0;
    this.cumulativeUsage.cacheRead += u.cacheRead ?? 0;
    this.cumulativeUsage.cacheWrite += u.cacheWrite ?? 0;
  }
}
