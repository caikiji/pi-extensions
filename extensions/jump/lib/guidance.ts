/**
 * System-prompt guidance text (promptSnippet + promptGuidelines) shared across
 * the jump tools. Injected into the default system prompt by pi when
 * the tool is active — the prompt-layer fix that discourages misuse on
 * short/linear tasks and enforces vs_plan discipline in jump payloads,
 * without relying on an external skill being loaded.
 */

/** One-liner shown in the Available tools section of the system prompt.
 *  Shared by label and jump — both are about folding away work you don't need
 *  to keep. label_list and label_peek have their own snippets because they
 *  are read-only navigation, not folding actions. */
export const COMMON_ANTI_PATTERN_SNIPPET =
  "label/jump: fold away intermediate work you won't need to keep. Use before long exploratory sub-tasks; NOT for short or linear work.";

/** Guideline bullets for the `label` tool. */
export const LABEL_GUIDELINES = [
  "Use label only before a sub-task whose intermediate steps you will NOT need afterward (large explorations, multi-file reads, many grep/find calls). Do NOT use it for short or linear work — folding there costs more than it saves and you risk losing your place.",
  "The `note` is the anchor's PURPOSE. Write BOTH why you are placing it now AND what you plan to do next. Bad: 'exploring auth module'. Good: 'login bug leaks token — exploring auth/, will jump back once I find the leak'. A note missing the WHY leaves the post-jump you unable to explain why the folded work existed.",
];

/** Guideline bullets for the `jump` tool. */
export const JUMP_GUIDELINES = [
  "Call jump ONLY as the final action of a sub-task — never call other tools in the same turn. The payload is your ONLY memory of the folded work.",
  "Payload must contrast with the target label's note (the plan): state what you completed, what you did NOT do, and anything NEW beyond the plan. Without this diff the post-jump you wrongly assumes the plan held.",
  "Do NOT chain jumps (jump to A, then jump to B from A, then to C...). Each jump folds another layer and recovery requires unwinding them in reverse. Jump back to a label, finish, then continue from the unfolded context — don't nest.",
  "A jump folds context for exactly ONE turn; the full context returns after. To re-fold, jump again. If you only need a detail from a folded branch, use label_peek instead of jump.",
];
