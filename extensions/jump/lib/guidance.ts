/**
 * System-prompt guidance text (promptSnippet + promptGuidelines) shared across
 * the jump tools. Injected into the default system prompt by pi when
 * the tool is active — the prompt-layer fix that discourages misuse on
 * short/linear tasks and enforces vs_plan discipline in jump payloads,
 * without relying on an external skill being loaded.
 */

/** One-liner shown in the Available tools section of the system prompt. */
export const COMMON_ANTI_PATTERN_SNIPPET =
  "label/jump: navigable context anchors. Use for long exploratory sub-tasks you want to fold away; NOT for short/linear work.";

/** Guideline bullets for the `label` tool. */
export const LABEL_GUIDELINES = [
  "Use label only before a sub-task whose intermediate steps you do NOT need to keep in context (large explorations, multi-file reads, many grep/find calls). Do NOT use it for short or linear work — folding there costs more than it saves and risks losing your place.",
  "The `note` is the anchor's PURPOSE, not decoration. Write WHY you are placing this label now + WHAT you plan to do next. A vague note like 'checkpoint' leaves the post-jump you unable to explain the folded gap.",
];

/** Guideline bullets for the `jump` tool. */
export const JUMP_GUIDELINES = [
  "Call jump ONLY as the final action of a sub-task — never call other tools in the same turn. The payload is your ONLY memory of the folded work.",
  "Payload must contrast with the target label's note (the plan): state what you completed, what you did NOT do, and anything NEW beyond the plan. Without this diff the post-jump you wrongly assumes the plan held.",
  "A jump folds context for exactly ONE turn; the full context returns after. To re-fold, jump again. Prefer label_peek over jump when you only want to glance at a folded branch.",
];
