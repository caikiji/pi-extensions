// Regression test for extensions/handoff.ts — the pure draft-store, arg
// parsing, display helpers, and draft-picker navigation (front matter
// round-trip, filenames, list sorting, arg parsing, picker key handling).
// The pi UI/LLM paths are not exercised here: they require the pi runtime.
// Uses tests/.work for throwaway files.
// Requires Node >= 22.18 — just run:  node tests/handoff.test.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const mod = await import(new URL("../extensions/handoff.ts", import.meta.url));
const {
	parseFrontMatter,
	serializeFrontMatter,
	timestampName,
	uniqueDraftName,
	writeDraft,
	readDraft,
	listDrafts,
	deleteDraft,
	parseHandoffArgs,
	goalLine,
	sanitizeTitle,
	parseTitle,
	formatCreated,
	draftsDir,
	showDraftPicker,
	ensureDraftDir,
	DRAFT_GITIGNORE,
	stripThinking,
	capConversationText,
	handoffOutputProblem,
} = mod;

let pass = 0, fail = 0;
function assert(cond, msg) {
	if (cond) { pass++; console.log(`  ok ${msg}`); }
	else { fail++; console.log(`  FAIL ${msg}`); }
}

const WORK = join(fileURLToPath(new URL(".", import.meta.url)), ".work", "handoff");
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const META = { name: "x.md", goal: "fix the test suite", title: "Fix the failing tests", created: "2026-01-15T14:30:00.000Z", source: "s1.md", model: "m1" };
const CONTENT = "## Context\nstuff here\n## Task\ndo it";

// --- front matter -----------------------------------------------------------

{
	const text = serializeFrontMatter(META, CONTENT);
	assert(text.startsWith("---\ngoal: fix the test suite\ntitle: Fix the failing tests\n"), "front matter header written");
	assert(text.endsWith(CONTENT), "content appended after front matter");
	const { meta, content } = parseFrontMatter(text);
	assert(meta.goal === "fix the test suite", "goal round-trips");
	assert(meta.title === "Fix the failing tests", "title round-trips");
	assert(meta.created === "2026-01-15T14:30:00.000Z", "created round-trips");
	assert(meta.source === "s1.md", "source round-trips");
	assert(meta.model === "m1", "model round-trips");
	assert(content === CONTENT, "content round-trips");
}

{
	const { meta, content } = parseFrontMatter("no front matter here");
	assert(Object.keys(meta).length === 0, "no-front-matter: empty meta");
	assert(content === "no front matter here", "no-front-matter: passthrough content");
}

{
	// a "---" line inside content must not swallow content
	const { meta, content } = parseFrontMatter("---\ngoal: g\n---\nbefore\n---\nafter");
	assert(meta.goal === "g", "front matter stops at first closing delimiter");
	assert(content === "before\n---\nafter", "content keeps embedded separator lines");
}

{
	// values may contain colons; split at first colon only
	const { meta } = parseFrontMatter("---\ngoal: fix: the tests\n---\nx");
	assert(meta.goal === "fix: the tests", "value keeps colons");
}

// --- filenames --------------------------------------------------------------

{
	const d = new Date(2026, 0, 15, 14, 30, 59);
	assert(timestampName(d) === "20260115-1430", "timestampName is YYYYMMDD-HHMM local");
}

{
	const dir = join(WORK, "names");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "20260115-1430.md"), "a");
	writeFileSync(join(dir, "20260115-1430-2.md"), "b");
	assert(uniqueDraftName(dir, new Date(2026, 0, 15, 14, 30)) === "20260115-1430-3.md", "collision bumps to -3");
	assert(uniqueDraftName(dir, new Date(2026, 0, 16, 9, 5)) === "20260116-0905.md", "free name stays plain");
}

// --- store lifecycle ---------------------------------------------------------

{
	const path = writeDraft(WORK, "20260115-1430.md", META, CONTENT);
	assert(existsSync(path), "writeDraft creates the file");
	assert(path.startsWith(draftsDir(WORK)), "writeDraft path lives under .pi/handoffs");
	const d = readDraft(WORK, "20260115-1430.md");
	assert(d !== null, "readDraft finds the draft");
	assert(d.meta.name === "20260115-1430.md", "readDraft fills name from filename");
	assert(d.content === CONTENT, "readDraft restores content without front matter");
}

{
	// a draft saved before the title feature must still load (title empty)
	const legacyDir = join(WORK, "legacy");
	mkdirSync(join(legacyDir, ".pi", "handoffs"), { recursive: true });
	writeFileSync(
		join(legacyDir, ".pi", "handoffs", "legacy.md"),
		"---\ngoal: old goal\ncreated: 2026-01-01T00:00:00.000Z\nsource: s\nmodel: m\n---\ncontent",
	);
	const d = readDraft(legacyDir, "legacy.md");
	assert(d !== null && d.meta.title === "", "legacy draft loads with empty title");
}
{
	assert(readDraft(WORK, "../escape.md") === null, "path traversal names are rejected");
	assert(readDraft(WORK, "missing.md") === null, "missing draft returns null");
}

{
	// two drafts, older created first in the dir -> list must be newest first
	const oldMeta = { ...META, name: "20260114-1000.md", created: "2026-01-14T10:00:00.000Z" };
	const newMeta = { ...META, name: "20260115-1430.md", created: "2026-01-15T14:30:00.000Z" };
	writeDraft(WORK, "20260114-1000.md", oldMeta, "old");
	writeDraft(WORK, "20260115-1430.md", newMeta, "new");
	const drafts = listDrafts(WORK);
	assert(drafts.length === 2, "listDrafts finds both drafts");
	assert(drafts[0].meta.name === "20260115-1430.md", "listDrafts sorts newest first");
}

{
	assert(deleteDraft(WORK, "20260114-1000.md") === true, "deleteDraft removes existing draft");
	assert(deleteDraft(WORK, "20260114-1000.md") === false, "deleteDraft false when gone");
	assert(deleteDraft(WORK, "nope.md") === false, "deleteDraft false for missing draft");
	assert(!existsSync(join(WORK, "20260114-1000.md")), "deleted file is really gone");
}

// --- draft dir gitignore (drafts must stay untracked by default) -----------

{
	const dir = join(WORK, "gitignore1");
	writeDraft(dir, "20260115-1430.md", META, CONTENT);
	const ignorePath = join(dir, ".pi", "handoffs", ".gitignore");
	assert(existsSync(ignorePath), "writeDraft creates .pi/handoffs/.gitignore");
	assert(readFileSync(ignorePath, "utf8") === DRAFT_GITIGNORE, "gitignore has the ignore-all pattern");
	assert(DRAFT_GITIGNORE === "*\n!.gitignore\n", "pattern matches the .pi/git/.gitignore content");
}

{
	// a user-customized ignore file is preserved
	const dir = join(WORK, "gitignore2");
	mkdirSync(join(dir, ".pi", "handoffs"), { recursive: true });
	const custom = "# mine\n*.tmp\n";
	writeFileSync(join(dir, ".pi", "handoffs", ".gitignore"), custom);
	writeDraft(dir, "20260115-1430.md", META, CONTENT);
	assert(readFileSync(join(dir, ".pi", "handoffs", ".gitignore"), "utf8") === custom, "user-customized .gitignore is kept");
}

{
	// ensureDraftDir is idempotent: creates dir + gitignore, never clobbers
	const dir = join(WORK, "gitignore3");
	const first = ensureDraftDir(dir);
	assert(first === draftsDir(dir), "ensureDraftDir returns the drafts dir");
	assert(existsSync(join(first, ".gitignore")), "ensureDraftDir writes the .gitignore");
	ensureDraftDir(dir);
	assert(readFileSync(join(first, ".gitignore"), "utf8") === DRAFT_GITIGNORE, "second ensure call keeps the content");
}

{
	// real git: drafts are ignored; only the .gitignore itself is visible
	const repo = join(WORK, "gitrepo");
	mkdirSync(repo, { recursive: true });
	const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeDraft(repo, "20260115-1430.md", META, CONTENT);
	const status = git(["status", "--porcelain", "--untracked-files=all"]).trim();
	assert(status === "?? .pi/handoffs/.gitignore", "only the .gitignore is untracked, drafts are ignored");
	const ignored = git(["check-ignore", ".pi/handoffs/20260115-1430.md"]).trim();
	assert(ignored === ".pi/handoffs/20260115-1430.md", "git check-ignore confirms the draft is ignored");
}

// --- arg parsing ---
{
	const a = parseHandoffArgs("");
	assert(a.kind === "goal" && a.goal === "", '"" -> goal flow');
	const b = parseHandoffArgs("  ");
	assert(b.kind === "goal" && b.goal === "", "whitespace -> goal flow");
	const c = parseHandoffArgs("list");
	assert(c.kind === "list", '"list" -> list');
	const d = parseHandoffArgs("load");
	assert(d.kind === "goal" && d.goal === "load", '"load" is a plain goal now (command removed)');
	const e = parseHandoffArgs("load 20260115-1430.md");
	assert(e.kind === "goal" && e.goal === "load 20260115-1430.md", '"load <name>" is a plain goal now');
	const f = parseHandoffArgs("fix the tests now");
	assert(f.kind === "goal" && f.goal === "fix the tests now", "goal text stays a goal");
}

// --- display helpers -----------------------------------------------------------

{
	assert(goalLine("a  b\n\tc") === "a b c", "goalLine collapses whitespace");
	assert(goalLine("x".repeat(100)).length === 60, "goalLine truncates to max");
	assert(goalLine("short") === "short", "goalLine keeps short text");
	// timezone-agnostic: build a local Date, round-trip through ISO
	const local = new Date(2026, 0, 15, 14, 30, 0);
	assert(formatCreated(local.toISOString()) === "2026-01-15 14:30", "formatCreated local time");
	assert(formatCreated("") === "", "formatCreated empty stays empty");
}

// --- parseTitle (session title from the model's closing line) -----------------

{
	const { title, body } = parseTitle("## Context\nwork\n## Task\ndo it\n\nTitle: Fix the failing tests\n", "fallback");
	assert(title === "Fix the failing tests", "parseTitle takes the trailing Title line");
	assert(body === "## Context\nwork\n## Task\ndo it\n", "parseTitle strips the Title line and trailing blank");
}
{
	const { title } = parseTitle("## Task\nx\n\n## Title: Markdown heading title\n", "fb");
	assert(title === "Markdown heading title", "parseTitle tolerates heading markers");
}
{
	const { title, body } = parseTitle("Title: Top title\n## Context\nx\n", "fb");
	assert(title === "Top title", "parseTitle scans the whole text when the line is not last");
	assert(body === "## Context\nx\n", "parseTitle strips a mid-text title line");
}
{
	const { title, body } = parseTitle("## Context\nx\n", "fallback goal");
	assert(title === "fallback goal", "parseTitle falls back to the goal when no Title line");
	assert(body === "## Context\nx\n", "parseTitle keeps the body untouched on fallback");
}
{
	assert(sanitizeTitle("  a   b\tc ") === "a b c", "sanitizeTitle collapses whitespace");
	const long = parseTitle("## C\n\nTitle: " + "y".repeat(100) + "\n", "fb");
	assert(long.title.length === 60, "parseTitle truncates titles to 60 chars");
	const only = parseTitle("Title: only title\n", "fb");
	assert(only.title === "only title", "parseTitle handles a title-only response");
}

{
	// a Title:-looking line deep in the body (e.g. echoed content) is not stripped
	const input = "## Context\nwork\nTitle: old session title\n## Task\ndo it\n";
	const { title, body } = parseTitle(input, "fallback goal");
	assert(title === "fallback goal", "parseTitle ignores a mid-body Title line (echoed content)");
	assert(body === input, "parseTitle keeps the body untouched when no title at head/tail");
}

// --- generation guards: stripThinking / capConversationText / handoffOutputProblem ---

{
	// stripThinking drops thinking blocks from assistant messages, keeps the rest
	const msgs = [
		{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "internal reasoning" },
				{ type: "text", text: "visible" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
			],
			timestamp: 2,
		},
	];
	const stripped = stripThinking(msgs);
	assert(stripped[0] === msgs[0], "stripThinking leaves user messages untouched");
	const a = stripped[1];
	assert(a.content.length === 2, "stripThinking removes thinking blocks");
	assert(a.content.every((c) => c.type !== "thinking"), "stripThinking drops all thinking blocks");
	assert(a.content.some((c) => c.type === "text" && c.text === "visible"), "stripThinking keeps assistant text");
	assert(a.content.some((c) => c.type === "toolCall"), "stripThinking keeps tool calls");
}

{
	// capConversationText keeps the newest context within the budget
	const short = "## Conversation History\nshort";
	assert(capConversationText(short, 1000) === short, "capConversationText passes short text through");
	const long = "x".repeat(500);
	const capped = capConversationText(long, 100);
	assert(capped.endsWith("x".repeat(100)), "capConversationText keeps the tail (newest context)");
	assert(/^\[\.\.\. \d+ characters of older context truncated \.\.\.\]/.test(capped), "capConversationText marks the truncation in ASCII");
}

{
	// handoffOutputProblem gates transcript echoes and oversized responses
	assert(handoffOutputProblem("") !== null, "empty response is rejected");
	assert(handoffOutputProblem("## Context\nwe fixed X\n## Task\ndo Y") === null, "normal summary passes");
	assert(handoffOutputProblem("[User]: pick a module") !== null, "echoed [User]: line is rejected");
	assert(handoffOutputProblem("[Tool result]: ok") !== null, "echoed [Tool result]: line is rejected");
	assert(handoffOutputProblem("[Assistant tool calls]: bash()") !== null, "echoed [Assistant tool calls]: line is rejected");
	assert(handoffOutputProblem("[Assistant thinking]: hmm") !== null, "echoed [Assistant thinking]: line is rejected");
	assert(handoffOutputProblem("before <begin> after") !== null, "transcript begin marker is rejected");
	assert(handoffOutputProblem("<end>") !== null, "transcript end marker is rejected");
	assert(handoffOutputProblem('<tool_calls><invoke name="bash">') !== null, "tool-call XML is rejected");
	assert(handoffOutputProblem("x".repeat(20000)) !== null, "oversized response is rejected");
	assert(handoffOutputProblem("ok".repeat(7500)) === null, "response at the limit passes");
}

// Stand-in for the pi keybindings manager: maps action ids to the key
// sequences pi's matchesKey would accept (legacy, app-cursor, kitty CSI-u).
function mockKeybindings() {
	const KEYS = {
		"tui.select.up": ["\x1b[A", "\x1bOA", "\x1b[57419u"],
		"tui.select.down": ["\x1b[B", "\x1bOB", "\x1b[57420u"],
		"tui.select.pageUp": ["\x1b[5~"],
		"tui.select.pageDown": ["\x1b[6~"],
		"tui.select.confirm": ["\r", "\n", "\x1b[13u"],
		"tui.select.cancel": ["\x1b", "\x1b[27u"],
		"tui.editor.cursorLeft": ["\x1b[D", "\x1bOD", "\x1b[57417u"],
		"tui.editor.deleteCharBackward": ["\x7f", "\x08", "\x1b[127u"],
	};
	return { matches: (data, id) => (KEYS[id] ?? []).includes(data) };
}

// --- draft picker navigation (mock ui.custom, pure string rendering) ----------

{
	const PK = join(WORK, "picker");
	mkdirSync(PK, { recursive: true });
	const metaA = { name: "20260115-1430.md", goal: "fix the tests", title: "Fix the tests", created: "2026-01-15T14:30:00.000Z", source: "s1.md", model: "m1" };
	const metaB = { name: "20260116-0900.md", goal: "deploy the app", title: "Deploy the app", created: "2026-01-16T09:00:00.000Z", source: "s2.md", model: "m1" };
	writeDraft(PK, metaA.name, metaA, "A");
	writeDraft(PK, metaB.name, metaB, "B");

	let factoryResult = null;
	let doneValue = undefined;
	const mockCtx = {
		cwd: PK,
		ui: {
			custom: async (factory) => {
				factoryResult = factory(
					{ requestRender() {} },
					{ fg: (_c, s) => s },
					mockKeybindings(),
					(v) => { doneValue = v; },
				);
				return null;
			},
		},
	};
	const drafts = listDrafts(PK); // sorted: B (newer) first
	await showDraftPicker(mockCtx, drafts);
	const comp = factoryResult;

	// browse mode renders rows + metadata pane
	let lines = comp.render(60);
	assert(lines.length > 3, "picker renders multiple lines");
	assert(lines[0].includes("Saved handoff drafts (2)"), "picker title shows count");
	assert(lines.some((l) => l.includes("deploy the app")), "picker lists drafts");
	assert(lines.some((l) => l.includes("goal:")), "picker shows metadata pane");

	// Enter -> menu, default Load
	comp.handleInput("\r");
	lines = comp.render(60);
	assert(lines.some((l) => l.includes("> Load")), "menu defaults to Load");
	assert(lines.some((l) => l.includes("Delete")), "menu lists Delete");

	// Left arrow -> back to browse (not cancelled)
	comp.handleInput("\x1b[D");
	assert(doneValue === undefined, "left arrow does not cancel");
	lines = comp.render(60);
	assert(lines[0].includes("Saved handoff drafts"), "left arrow returns to the list");

	// Enter -> menu -> Enter -> Load resolves with the selected draft
	comp.handleInput("\r");
	comp.handleInput("\r");
	assert(doneValue === "load:20260116-0900.md", "Load returns the selected draft");

	// down arrow selects the second draft, then Edit
	doneValue = undefined;
	comp.handleInput("\r"); // menu again (still in menu after done)
	comp.handleInput("\x1b[B"); // down: Edit
	comp.handleInput("\r");
	assert(doneValue === "edit:20260116-0900.md", "Edit returns the selected draft");

	// Delete: back to browse, menu -> down to Delete -> confirm defaults to Cancel
	doneValue = undefined;
	comp.handleInput("\x1b[D"); // left: back to browse
	comp.handleInput("\r"); // browse -> menu (Load default)
	comp.handleInput("\x1b[B");
	comp.handleInput("\x1b[B"); // Delete
	comp.handleInput("\r"); // enter confirmDelete
	lines = comp.render(60);
	assert(lines.some((l) => l.includes("> Cancel")), "delete confirm defaults to Cancel");
	comp.handleInput("\r"); // confirm Cancel -> back to menu
	assert(doneValue === undefined, "confirming Cancel does not delete");
	lines = comp.render(60);
	assert(lines.some((l) => l.includes("> Delete")), "Cancel returns to the action menu (Delete stays selected)");

	// ... then confirm Delete directly (menu already on Delete)
	comp.handleInput("\r");
	comp.handleInput("\x1b[B"); // switch to Delete
	comp.handleInput("\r");
	assert(doneValue === "delete:20260116-0900.md", "confirming Delete deletes the draft");

	// Esc cancels everything from the browse level
	doneValue = undefined;
	comp.handleInput("\x1b");
	assert(doneValue === null, "Esc cancels the picker");
}

// --- picker filtering -----------------------------------------------------------

{
	const PK = join(WORK, "picker3");
	mkdirSync(PK, { recursive: true });
	writeDraft(PK, "20260115-1430.md", { name: "20260115-1430.md", goal: "fix the tests", title: "Fix the tests", created: "2026-01-15T14:30:00.000Z", source: "s", model: "m" }, "A");
	writeDraft(PK, "20260116-0900.md", { name: "20260116-0900.md", goal: "deploy the app", title: "Deploy the app", created: "2026-01-16T09:00:00.000Z", source: "s", model: "m" }, "B");
	let factoryResult = null;
	const mockCtx = {
		cwd: PK,
		ui: { custom: async (factory) => { factoryResult = factory({ requestRender() {} }, { fg: (_c, s) => s }, mockKeybindings(), () => {}); return null; } },
	};
	await showDraftPicker(mockCtx, listDrafts(PK));
	const comp = factoryResult;

	comp.handleInput("d"); // filter: only "deploy the app" matches
	let lines = comp.render(60);
	assert(lines[0].includes("(1)") && lines[0].includes("filter: d"), "typing filters the list");
	assert(lines.some((l) => l.includes("deploy the app")), "filter keeps the match");
	assert(!lines.some((l) => l.includes("fix the tests")), "filter drops non-matches");

	comp.handleInput("\x7f"); // backspace clears filter
	lines = comp.render(60);
	assert(lines[0].includes("(2)"), "backspace restores the full list");
}

// --- picker width safety (the crash the user hit: lines must not exceed width) --

{
	// visible width: strip ANSI, wide chars count 2
	function vw(s) {
		const plain = s.split("").join("").replace(/[[0-9;]*m/g, "");
		let n = 0;
		for (const ch of plain) n += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
		return n;
	}
	const PK = join(WORK, "picker4");
	mkdirSync(PK, { recursive: true });
	// long uuid-ish source + CJK goal (worst case for width)
	const longSource = "2026-08-01T10-43-01-622Z_019fbceb-8d76-7fa0-9a1b-c2d3e4f5a6b7.jsonl";
	writeDraft(PK, "20260801-1843.md", { name: "20260801-1843.md", goal: "你好，这是一段非常长的中文交接目标用来测试宽度截断是否生效，应该被安全截断", title: "中文标题", created: "2026-08-01T10:43:00.000Z", source: longSource, model: "deepseek-v4-flash" }, "A");
	let factoryResult = null;
	const mockCtx = {
		cwd: PK,
		ui: { custom: async (factory) => { factoryResult = factory({ requestRender() {} }, { fg: (_c, s) => s }, mockKeybindings(), () => {}); return null; } },
	};
	await showDraftPicker(mockCtx, listDrafts(PK));
	const comp = factoryResult;
	for (const width of [40, 80, 130]) {
		const lines = comp.render(width);
		const worst = Math.max(...lines.map(vw));
		assert(worst <= width, `no rendered line exceeds width ${width} (worst ${worst})`);
	}
	// metadata pane lines exist and are truncated (long source shortened)
	const lines = comp.render(60);
	const srcLine = lines.find((l) => l.includes("source:"));
	assert(srcLine !== undefined && vw(srcLine) <= 60, "source line is visible-width truncated");
}
// --- picker keys are routed through the keybindings manager (kitty CSI-u) -----

{
	const PK = join(WORK, "picker5");
	mkdirSync(PK, { recursive: true });
	writeDraft(PK, "20260115-1430.md", { name: "20260115-1430.md", goal: "fix the tests", title: "Fix the tests", created: "2026-01-15T14:30:00.000Z", source: "s", model: "m" }, "A");
	writeDraft(PK, "20260116-0900.md", { name: "20260116-0900.md", goal: "deploy the app", title: "Deploy the app", created: "2026-01-16T09:00:00.000Z", source: "s", model: "m" }, "B");
	let factoryResult = null;
	let doneValue = undefined;
	const mockCtx = {
		cwd: PK,
		ui: { custom: async (factory) => { factoryResult = factory({ requestRender() {} }, { fg: (_c, s) => s }, mockKeybindings(), (v) => { doneValue = v; }); return null; } },
	};
	await showDraftPicker(mockCtx, listDrafts(PK)); // sorted: B (newer) first
	const comp = factoryResult;

	// kitty CSI-u arrows: down = ESC[57420u, up = ESC[57419u
	comp.handleInput("\x1b[57420u");
	let lines = comp.render(60);
	assert(lines.some((l) => l.startsWith("> 2 |")), "kitty CSI-u down arrow moves selection");
	comp.handleInput("\x1b[57419u");
	lines = comp.render(60);
	assert(lines.some((l) => l.startsWith("> 1 |")), "kitty CSI-u up arrow moves selection");

	// application-cursor-mode arrow: down = ESC OB
	comp.handleInput("\x1bOB");
	lines = comp.render(60);
	assert(lines.some((l) => l.startsWith("> 2 |")), "app-cursor-mode down arrow moves selection");

	// page up/down
	comp.handleInput("\x1b[6~"); // page down
	lines = comp.render(60);
	assert(lines.some((l) => l.startsWith("> 2 |")), "page down moves selection");
	comp.handleInput("\x1b[5~"); // page up
	lines = comp.render(60);
	assert(lines.some((l) => l.startsWith("> 1 |")), "page up moves selection");

	// kitty CSI-u enter (ESC[13u) opens the action menu
	comp.handleInput("\x1b[13u");
	lines = comp.render(60);
	assert(lines.some((l) => l.includes("> Load")), "kitty CSI-u enter opens the action menu");

	// kitty CSI-u escape (ESC[27u) cancels from the menu
	comp.handleInput("\x1b[27u");
	assert(doneValue === null, "kitty CSI-u escape cancels the picker");
}

// --- kitty CSI-u backspace clears the filter -----------------------------------

{
	const PK = join(WORK, "picker6");
	mkdirSync(PK, { recursive: true });
	writeDraft(PK, "20260115-1430.md", { name: "20260115-1430.md", goal: "fix the tests", title: "Fix the tests", created: "2026-01-15T14:30:00.000Z", source: "s", model: "m" }, "A");
	let factoryResult = null;
	const mockCtx = {
		cwd: PK,
		ui: { custom: async (factory) => { factoryResult = factory({ requestRender() {} }, { fg: (_c, s) => s }, mockKeybindings(), () => {}); return null; } },
	};
	await showDraftPicker(mockCtx, listDrafts(PK));
	const comp = factoryResult;
	comp.handleInput("f"); // filter: "fix the tests" matches
	comp.handleInput("\x1b[127u"); // kitty CSI-u backspace
	const lines = comp.render(60);
	assert(lines[0].includes("(1)") && !lines[0].includes("filter"), "kitty CSI-u backspace clears the filter");
}

// --- emoji goals: no lone surrogates and correct width in rendered lines -------

{
	function vw(s) {
		const plain = s.split("\x1b").join(" ").replace(/\[[0-9;]*m/g, "");
		let n = 0;
		for (const ch of plain) n += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
		return n;
	}
	const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
	const PK = join(WORK, "picker7");
	mkdirSync(PK, { recursive: true });
	// A: emoji at the 40-char goalLine cut; B: emoji at the 60-col fit cut
	writeDraft(PK, "20260117-1200.md", { name: "20260117-1200.md", goal: "a".repeat(39) + "\u{1F680}" + "b".repeat(30), title: "t", created: "2026-01-17T12:00:00.000Z", source: "s", model: "m" }, "A");
	writeDraft(PK, "20260118-1200.md", { name: "20260118-1200.md", goal: "a".repeat(52) + "\u{1F680}" + "b".repeat(30), title: "t", created: "2026-01-18T12:00:00.000Z", source: "s", model: "m" }, "B");
	let factoryResult = null;
	const mockCtx = {
		cwd: PK,
		ui: { custom: async (factory) => { factoryResult = factory({ requestRender() {} }, { fg: (_c, s) => s }, mockKeybindings(), () => {}); return null; } },
	};
	await showDraftPicker(mockCtx, listDrafts(PK));
	const comp = factoryResult;
	for (const width of [40, 59, 60, 61, 80, 130]) {
		const lines = comp.render(width);
		assert(lines.every((l) => !loneSurrogate.test(l)), `no lone surrogate at width ${width}`);
		assert(Math.max(...lines.map(vw)) <= width, `emoji lines stay within width ${width}`);
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
