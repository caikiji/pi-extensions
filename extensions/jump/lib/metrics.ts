/**
 * Context-metrics reporting. Builds the `Context metrics:` block shown at the
 * top of label_list, giving the model a quantitative sense of its own context.
 *
 * Three distinct numbers (the key correctness property):
 *   - window:   hard ceiling (model contextWindow)
 *   - physical: tokens in the PHYSICAL array (matches footer %), incl. folded
 *   - in-view:  tokens the model will ACTUALLY see (projected, post-fold)
 *
 * Why physical != in-view matters: pi's getContextUsage().tokens measures the
 * PHYSICAL array using real provider usage + trailing chars/4. It does NOT
 * reflect the jump projection. So during an active jump, physical stays high
 * while the model only sees the folded (smaller) array. We compute in-view =
 * physical - lastFoldedEstimate so the model knows how much room it REALLY
 * has. When no jump is active, in-view == physical (no estimation needed).
 */
import type { ContextUsageSnapshot, GraphState } from "./state.ts";

/** Format a token count for display: k for thousands, M for millions. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_0) / 100}k`;
  return String(n);
}

/** Minimal ctx shape we need — just getContextUsage(). Keeps this module
 *  decoupled from the full ExtensionContext. */
export interface MetricsCtx {
  getContextUsage(): ContextUsageSnapshot | undefined;
}

/** Build the context-metrics block. Returns null if there's nothing to report
 *  yet (no window, no physical, no usage). */
export function buildContextReport(state: GraphState, ctx: MetricsCtx): string | null {
  const usage = ctx.getContextUsage();
  if (usage) state.lastContextUsage = usage;

  const window = state.lastContextUsage?.contextWindow ?? 0;
  const physical = state.lastContextUsage?.tokens ?? null;
  const physicalPct = state.lastContextUsage?.percent ?? null;

  // in-view = physical minus the folded region (only when a jump is active).
  // We do NOT estimate the whole array — pi's `physical` is already accurate
  // (it uses real provider usage). We only estimate the small folded region
  // and subtract, so error stays bounded to that region.
  let inView: number | null = null;
  if (physical !== null && state.activeJumpId && state.lastFoldedEstimate !== null) {
    inView = Math.max(0, physical - state.lastFoldedEstimate);
  } else if (physical !== null && !state.activeJumpId) {
    inView = physical; // no fold → model sees the full physical array
  }

  // Cache hit ratio = cacheRead / (cacheRead + input) over the session.
  const denom = state.cumulativeUsage.cacheRead + state.cumulativeUsage.input;
  const cacheHit = denom > 0 ? (state.cumulativeUsage.cacheRead / denom) * 100 : null;

  if (!window && physical === null && inView === null && denom === 0) {
    return null; // nothing to report yet
  }

  const lines: string[] = ["Context metrics:"];
  if (window > 0) {
    lines.push(`  window:   ${fmtTokens(window)} (model context ceiling)`);
  }
  if (physical !== null) {
    const pctStr = physicalPct !== null ? ` (${physicalPct.toFixed(1)}% of window)` : "";
    const physDesc = state.activeJumpId
      ? "full array incl. folded-away work"
      : "full array (no active fold)";
    lines.push(`  physical: ${fmtTokens(physical)}${pctStr} — ${physDesc}`);
  }
  if (inView !== null) {
    let inViewNote: string;
    if (state.activeJumpId && physical !== null && physical > inView) {
      inViewNote = ` — folded −${fmtTokens(physical - inView)} via active jump`;
    } else {
      inViewNote = " — what you actually see next turn";
    }
    lines.push(`  in-view:  ${fmtTokens(inView)}${inViewNote}`);
  } else {
    lines.push(`  in-view:  (unknown — no context usage yet)`);
  }
  if (denom > 0) {
    const hitStr = cacheHit !== null ? ` CH${cacheHit.toFixed(1)}%` : "";
    lines.push(
      `  cumul:    ↑${fmtTokens(state.cumulativeUsage.input)} ↓${fmtTokens(state.cumulativeUsage.output)} R${fmtTokens(state.cumulativeUsage.cacheRead)}${hitStr}`,
    );
  }
  return lines.join("\n");
}
