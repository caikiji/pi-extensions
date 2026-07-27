/**
 * Shared types and constants for the jump extension.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** A node in the logical graph. id is the toolCallId of the creating call. */
export interface GraphNode {
  id: string;
  kind: "label" | "jump";
  /** Index into the *physical* AgentMessage[] of the message this node is anchored to.
   *  For label: the label-tool's own ToolResultMessage.
   *  For jump:   the jump-tool's own ToolResultMessage (the injected branch root).
   *  Persisted as -1 (unresolved); always re-resolved by toolCallId at runtime,
   *  because physical indices shift across compaction / resume / fork. */
  anchorIndex: number;
  note?: string;
  /** For jump nodes: the id we jumped from (trunk or another branch). */
  jumpedFrom?: string;
  /** For jump nodes: short text preview of the folded region, captured at
   *  jump time from the live message array. Lets label_list show what a branch
   *  contains without the agent having to jump into it. */
  preview?: string;
  /** For jump nodes: how many physical messages were folded away. Surfaces in
   *  the jump result + label_list so the agent can judge the fold's cost. */
  foldedCount?: number;
  createdAt: number;
}

export interface PersistedState {
  nodes: Record<string, GraphNode>;
  /** Persisted only for diagnostics; runtime activeJumpId is transient and
   *  always starts as null on (re)start. */
  activeJumpId: string | null;
}

/** CustomEntry type tag used for graph-state persistence (not sent to LLM). */
export const PERSIST_TYPE = "jump-state";

/** Soft cap on retained graph nodes. Nodes are logical bookmarks; once the
 *  graph grows beyond this, the oldest never-revisited labels are pruned.
 *  Jump nodes are always retained (they are re-visit targets). */
export const MAX_NODES = 200;

/** Max chars of a branch preview stored on a jump node. */
export const PREVIEW_MAX = 200;
/** Max chars label_peek returns of the folded region. */
export const PEEK_MAX = 2000;

/** Token estimate divisor — pi's own estimator uses chars/4, so we match it
 *  to keep our folded-region estimate roughly consistent with pi's physical
 *  count. This is a rough heuristic, not a precise tokenizer. */
export const CHARS_PER_TOKEN = 4;

/** Minimal shape of a message we read for text/token extraction. We keep it
 *  structural (not importing the full union) so the helpers stay decoupled
 *  from the exact AgentMessage variant. */
export type AnyMessage = AgentMessage;
