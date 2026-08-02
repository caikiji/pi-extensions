// Regression test for extensions/checkpoint.ts.
// Creates a throwaway git repo in tests/.work and exercises the full
// snapshot / restore / drop lifecycle with real git. No network, no npm deps.
// Requires Node >= 22.18 — just run:  node tests/checkpoint.test.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mod = await import(new URL("../extensions/checkpoint.ts", import.meta.url));

let pass = 0, fail = 0;
function assert(cond, msg) {
	if (cond) { pass++; console.log(`  ✓ ${msg}`); }
	else { fail++; console.log(`  ✗ FAIL: ${msg}`); }
}

const TMP = join(fileURLToPath(new URL(".", import.meta.url)), ".work", "cp-repo");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

function git(args, cwd = TMP) {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { stdout: out, stderr: "", code: 0 };
	} catch (err) {
		// mimic pi.exec: non-zero exit returns a result instead of throwing
		return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.status ?? 1 };
	}
}
const exec = (cmd, args, opts) => git(args, opts?.cwd ?? TMP);
const read = (p) => readFileSync(join(TMP, p), "utf8");
const write = (p, c) => writeFileSync(join(TMP, p), c);

// ---- fake pi API ----
const handlers = {};
const commands = {};
const tools = {};
const fakePi = {
	on: (name, h) => { handlers[name] = h; },
	registerCommand: (name, opts) => { commands[name] = opts; },
	registerTool: (def) => { tools[def.name] = def; },
	exec: (cmd, args, opts) => Promise.resolve(git(args, opts?.cwd ?? TMP)),
};
await mod.default(fakePi);

// ================= Test 1: setup repo =================
console.log("Test 1: repo setup");
{
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	write("a.txt", "v1");
	write("keep.txt", "keep");
	git(["add", "."]);
	git(["commit", "-qm", "init"]);
	assert(existsSync(join(TMP, ".git")), "git repo ready");
}

// ================= Test 2: create =================
console.log("Test 2: createCheckpoint captures tracked + untracked");
{
	write("a.txt", "v2-agent");
	write("keep.txt", "keep-user");
	write("new.txt", "brand new");
	const e = await mod.createCheckpoint(exec, TMP, "refactor a", false);
	assert(e !== null, "checkpoint created");
	assert(e.tracked.includes("a.txt") && e.tracked.includes("keep.txt"), "tracked files listed");
	assert(e.untracked.includes("new.txt"), "untracked file captured");
	assert(e.auto === false && e.msg === "refactor a", "meta fields");
	// ref kept alive against gc
	const refs = git(["show-ref"]).stdout;
	assert(refs.includes(`refs/pi-checkpoints/${e.id}`), "ref created to protect from gc");
}

// ================= Test 3: list + format =================
console.log("Test 3: listCheckpoints + formatEntries");
{
	const entries = await mod.listCheckpoints(exec, TMP);
	assert(entries.length === 1, "one entry listed");
	const txt = mod.formatEntries(entries);
	assert(txt.includes("refactor a") && txt.includes("3 files"), "format shows msg + file count");
	assert(mod.formatEntries([]).includes("no checkpoints"), "empty list message");
}

// ================= Test 4: restore =================
console.log("Test 4: restore reverts captured files only");
{
	// snapshot id: capture again after more edits so restore has a clear target
	const e = await mod.createCheckpoint(exec, TMP, "baseline", false);
	write("a.txt", "v3-broken");
	write("new.txt", "new-but-broken");
	write("extra.txt", "untouched by checkpoint");
	const res = await mod.restoreCheckpoint(exec, TMP, e.id);
	assert(res.ok === false && res.conflicts.length === 2, "conflicts on files changed after checkpoint");
	assert(read("a.txt") === "v3-broken", "conflicting files untouched without force");
	assert(read("extra.txt") === "untouched by checkpoint", "files outside checkpoint untouched");
	const res2 = await mod.restoreCheckpoint(exec, TMP, e.id, { force: true });
	assert(res2.ok && res2.restored.includes("a.txt") && res2.restored.includes("new.txt"), "force restores conflicting files");
	assert(read("a.txt") === "v2-agent", "a.txt reverted to checkpoint state");
	assert(read("new.txt") === "brand new", "new.txt reverted");
	assert(read("extra.txt") === "untouched by checkpoint", "extra.txt still untouched");
	assert(read("keep.txt") === "keep-user", "user's own change on keep.txt preserved (it was captured too)");
}

// ================= Test 5: id prefix + latest + unknown =================
console.log("Test 5: id matching");
{
	const entries = await mod.listCheckpoints(exec, TMP);
	const e = entries.find((x) => !x.msg.startsWith("pre-restore")); // skip restore side-effects
	const res = await mod.restoreCheckpoint(exec, TMP, e.id.slice(0, 10));
	assert(res.ok, "id prefix matches");
	const res2 = await mod.restoreCheckpoint(exec, TMP, "latest");
	assert(res2.ok, "'latest' matches newest");
	const res3 = await mod.restoreCheckpoint(exec, TMP, "nope");
	assert(res3.ok === false && res3.error.includes("not found"), "unknown id errors");
	const res4 = await mod.restoreCheckpoint(exec, "/not/a/repo", "latest");
	assert(res4.ok === false && res4.error.includes("not a git"), "non-repo errors");
}

// ================= Test 6: deleted file restore =================
console.log("Test 6: snapshot with a deleted file");
{
	write("del.txt", "will be deleted");
	git(["add", "del.txt"]);
	git(["commit", "-qm", "add del.txt"]);
	git(["rm", "-q", "del.txt"]);
	git(["commit", "-qm", "remove del.txt"]);
	write("del.txt", "recreated after removal");
	const e = await mod.createCheckpoint(exec, TMP, "with del", false);
	assert(e.untracked.includes("del.txt"), "recreated-after-HEAD file captured as untracked");
	const res = await mod.restoreCheckpoint(exec, TMP, e.id);
	// snapshot has del.txt; current == HEAD? No: current is "recreated", HEAD lacks it.
	// current != head (""), current == snap → restorable, no conflict
	assert(res.ok, "restore ok");
	assert(read("del.txt") === "recreated after removal", "file restored to snapshot state");
}

// ================= Test 7: drop =================
console.log("Test 7: dropCheckpoint");
{
	const entries = await mod.listCheckpoints(exec, TMP);
	const n = entries.length;
	const e = entries[0];
	const dropped = await mod.dropCheckpoint(exec, TMP, e.id);
	assert(dropped.length === 1 && dropped[0] === e.id, "drop by id");
	assert((await mod.listCheckpoints(exec, TMP)).length === n - 1, "entry removed");
	assert(!git(["show-ref"]).stdout.includes(e.id), "git ref removed");
	const all = await mod.dropCheckpoint(exec, TMP, "all");
	assert(all.length === n - 1, "drop all removes the rest");
	assert((await mod.listCheckpoints(exec, TMP)).length === 0, "state empty");
}

// ================= Test 8: clean worktree → null =================
console.log("Test 8: clean worktree produces no checkpoint");
{
	git(["add", "-A"]);
	git(["commit", "-qm", "clean"]);
	const e = await mod.createCheckpoint(exec, TMP, "clean?", false);
	assert(e === null, "null when nothing changed");
}

// ================= Test 9: auto ring + turn_start hook =================
console.log("Test 9: auto checkpoints pruned to a ring of 20");
{
	for (let i = 0; i < 25; i++) {
		write("a.txt", `auto-${i}`);
		await mod.createCheckpoint(exec, TMP, "auto", true);
	}
	const entries = await mod.listCheckpoints(exec, TMP);
	const autos = entries.filter((e) => e.auto);
	assert(autos.length === 20, `auto ring capped at 20 (got ${autos.length})`);
	// turn_start handler exists and is safe to call
	assert(typeof handlers["turn_start"] === "function", "turn_start hook registered");
	await handlers["turn_start"]({}, { cwd: TMP });
	await handlers["turn_start"]({}, { cwd: "/not/a/repo" }); // must not throw
	assert(true, "turn_start hook runs without throwing");
}

// ================= Test 10: registration =================
console.log("Test 10: extension registers tools + commands");
{
	assert(typeof tools["checkpoint_list"] === "object", "checkpoint_list tool");
	assert(typeof tools["checkpoint_restore"] === "object", "checkpoint_restore tool");
	assert(typeof commands["checkpoint"] === "object", "/checkpoint command");
	assert(typeof commands["restore"] === "object", "/restore command");
	// tool execute paths with fake ctx
	const listRes = await tools["checkpoint_list"].execute("t1", {}, undefined, undefined, { cwd: TMP });
	assert(listRes.content[0].text.includes("auto"), "checkpoint_list execute works");
	const restoreRes = await tools["checkpoint_restore"].execute("t2", { id: "latest" }, undefined, undefined, { cwd: TMP });
	assert(restoreRes.details.ok === true, "checkpoint_restore execute works");
	const badRes = await tools["checkpoint_restore"].execute("t3", { id: "zzz" }, undefined, undefined, { cwd: TMP });
	assert(badRes.isError === true && badRes.content[0].text.includes("not found"), "unknown id → error result");
}

// ================= Test 11: repo param, cwd-aware errors, pre-restore =================
console.log("Test 11: repo param, cwd-aware errors, pre-restore snapshot");
{
	// A directory outside any git repo.
	const OUTSIDE = mkdirSync(join(tmpdir(), "pi-cp-out-" + Date.now()), { recursive: true });
	const noRepo = await tools["checkpoint_list"].execute("t4", {}, undefined, undefined, { cwd: OUTSIDE });
	assert(noRepo.isError === true && noRepo.content[0].text.includes("not a git repository"), "non-repo cwd -> cwd-aware error");
	const withRepo = await tools["checkpoint_list"].execute("t5", { repo: TMP }, undefined, undefined, { cwd: OUTSIDE });
	assert(withRepo.isError === undefined && withRepo.content[0].text.includes("auto"), "repo param resolves the repo from an outside cwd");
	const badRes = await tools["checkpoint_restore"].execute("t6", { id: "zzz" }, undefined, undefined, { cwd: OUTSIDE });
	assert(badRes.isError === true && badRes.content[0].text.includes("not a git repository"), "restore outside repo -> cwd-aware error");
	// A restore must first snapshot the current state (pre-restore) so it can be undone.
	writeFileSync(join(TMP, "pre.txt"), "v1");
	const cp = await mod.createCheckpoint(exec, TMP, "pre test", false);
	writeFileSync(join(TMP, "pre.txt"), "v2");
	const res = await mod.restoreCheckpoint(exec, TMP, cp.id, { force: true });
	assert(res.ok === true && readFileSync(join(TMP, "pre.txt"), "utf8") === "v1", "force restore still works");
	const all = await mod.listCheckpoints(exec, TMP);
	assert(all.some((e) => e.msg.startsWith("pre-restore")), "pre-restore snapshot created on restore");
	rmSync(OUTSIDE, { recursive: true, force: true });
}

// ================= Test 12: untracked-only snapshot (Bug 2) =================
console.log("Test 12: untracked-only checkpoint (no tracked changes)");
{
	git(["add", "-A"]);
	git(["commit", "-qm", "clean for untracked-only"]);
	write("uonly.txt", "u1");
	const e = await mod.createCheckpoint(exec, TMP, "untracked only", false);
	assert(e !== null && e.sha === "" && e.tracked.length === 0 && e.untracked.includes("uonly.txt"), "untracked-only checkpoint captures new file");
	// break it, then restore brings it back
	write("uonly.txt", "u2-broken");
	const res = await mod.restoreCheckpoint(exec, TMP, e.id, { force: true });
	assert(res.ok && read("uonly.txt") === "u1", "untracked-only restore works");
}

// ================= Test 13: subdir cwd (Bug 1) =================
console.log("Test 13: create + restore from a subdirectory cwd");
{
	mkdirSync(join(TMP, "nested"), { recursive: true });
	write("nested/f.txt", "n1");
	const e = await mod.createCheckpoint(exec, join(TMP, "nested"), "subdir cp", false);
	assert(e !== null && e.untracked.includes("nested/f.txt"), "untracked paths are repo-root-relative from subdir");
	write("nested/f.txt", "n2-broken");
	const res = await mod.restoreCheckpoint(exec, join(TMP, "nested"), e.id, { force: true });
	assert(res.ok && read("nested/f.txt") === "n1", "restore from subdir cwd restores the right file");
}

// ================= Test 14: revert-to-HEAD is a conflict (Issue 3) =================
console.log("Test 14: reverting a file to HEAD after the checkpoint is a conflict");
{
	write("a.txt", "issue3-v2");
	const e = await mod.createCheckpoint(exec, TMP, "issue3", false);
	git(["checkout", "-q", "HEAD", "--", "a.txt"]); // revert to HEAD after checkpoint
	const res = await mod.restoreCheckpoint(exec, TMP, e.id);
	assert(res.ok === false && res.conflicts.includes("a.txt"), "revert-to-HEAD is detected as a conflict");
	// and --force still restores the snapshot content
	const res2 = await mod.restoreCheckpoint(exec, TMP, e.id, { force: true });
	assert(res2.ok && read("a.txt") === "issue3-v2", "force restores over the revert");
}

// ================= Test 15: fresh repo with no HEAD =================
console.log("Test 15: fresh repo (no initial commit) captures untracked files");
{
	const FRESH = join(tmpdir(), "pi-cp-fresh-" + Date.now());
	mkdirSync(FRESH, { recursive: true });
	git(["init", "-q"], FRESH);
	git(["config", "user.email", "t@t"], FRESH);
	git(["config", "user.name", "t"], FRESH);
	writeFileSync(join(FRESH, "fresh.txt"), "f1");
	const e = await mod.createCheckpoint(exec, FRESH, "fresh", false);
	assert(e !== null && e.sha === "" && e.untracked.includes("fresh.txt"), "fresh repo untracked-only checkpoint");
	writeFileSync(join(FRESH, "fresh.txt"), "f2-broken");
	const res = await mod.restoreCheckpoint(exec, FRESH, e.id, { force: true });
	assert(res.ok && readFileSync(join(FRESH, "fresh.txt"), "utf8") === "f1", "fresh repo restore works");
	rmSync(FRESH, { recursive: true, force: true });
}

// ================= Test 16: staged change after checkpoint =================
console.log("Test 16: a staged change after the checkpoint is a conflict");
{
	write("a.txt", "staged-v1");
	const e = await mod.createCheckpoint(exec, TMP, "staged", false);
	write("a.txt", "staged-v2");
	git(["add", "a.txt"]);
	const res = await mod.restoreCheckpoint(exec, TMP, e.id);
	assert(res.ok === false && res.conflicts.includes("a.txt"), "staged change detected as conflict");
	git(["reset", "-q"]);
}

// ================= Test 17: argument completions =================
console.log("Test 17: /checkpoint and /restore argument completions");
{
	// lastCwd is populated by the turn_start hook (called in Test 9);
	// make sure it points at TMP so real checkpoint ids are listed.
	await handlers["turn_start"]({}, { cwd: TMP });
	const cpCmd = commands["checkpoint"];
	const rsCmd = commands["restore"];
	assert(typeof cpCmd.getArgumentCompletions === "function" && typeof rsCmd.getArgumentCompletions === "function", "both commands expose getArgumentCompletions");
	// empty prefix -> subcommands
	const empty = await cpCmd.getArgumentCompletions("");
	assert(Array.isArray(empty) && empty.some((i) => i.value === "list") && empty.some((i) => i.value === "drop"), "empty prefix suggests list + drop");
	// "list " -> --full
	const listC = await cpCmd.getArgumentCompletions("list ");
	assert(Array.isArray(listC) && listC.some((i) => i.value === "list --full"), "list subcommand suggests --full");
	// "drop " -> all + real ids
	const dropC = await cpCmd.getArgumentCompletions("drop ");
	assert(Array.isArray(dropC) && dropC.some((i) => i.value === "drop all"), "drop suggests all");
	const entries = await mod.listCheckpoints(exec, TMP);
	if (entries.length > 0) {
		assert(dropC.some((i) => i.value === `drop ${entries[0].id}`), "drop suggests real checkpoint ids");
	}
	// free-text message -> no completion
	const msgC = await cpCmd.getArgumentCompletions("refactor a");
	assert(!Array.isArray(msgC) || msgC.length === 0, "free-text message gets no completion");
	// /restore: latest + --force + real ids
	const rs = await rsCmd.getArgumentCompletions("");
	assert(Array.isArray(rs) && rs.some((i) => i.value === "latest") && rs.some((i) => i.value === "--force"), "restore suggests latest + --force");
	if (entries.length > 0) {
		assert(rs.some((i) => i.value === entries[0].id), "restore suggests real checkpoint ids");
	}
	const rsPrefix = await rsCmd.getArgumentCompletions("la");
	assert(rsPrefix.some((i) => i.value === "latest"), "restore filters by prefix");
}

// ================= Test 18: empty / whitespace ids are refused =================
console.log("Test 18: empty and whitespace ids are refused");
{
	write("a.txt", "t18-v1");
	const e = await mod.createCheckpoint(exec, TMP, "t18", false);
	write("a.txt", "t18-broken");
	const res = await mod.restoreCheckpoint(exec, TMP, "");
	assert(res.ok === false && res.error.includes("id required"), "empty id refused (no silent latest match)");
	const res2 = await mod.restoreCheckpoint(exec, TMP, "   ");
	assert(res2.ok === false && res2.error.includes("id required"), "whitespace id refused");
	assert(read("a.txt") === "t18-broken", "nothing was restored by the empty id");
	assert((await mod.dropCheckpoint(exec, TMP, "")).length === 0, "empty drop is a no-op");
	const res3 = await mod.restoreCheckpoint(exec, TMP, e.id, { force: true });
	assert(res3.ok && read("a.txt") === "t18-v1", "explicit id still restores");
}

// ================= Test 19: ambiguous id prefixes are refused =================
console.log("Test 19: ambiguous id prefixes are refused");
{
	const stateFile = join(TMP, ".git", "pi-checkpoints", "state.json");
	const state = JSON.parse(readFileSync(stateFile, "utf8"));
	state.entries.push(
		{ id: "cp-test0000-aaaa", msg: "fake A", ts: Date.now() - 2000, sha: "", tracked: [], untracked: [], skipped: [], auto: false },
		{ id: "cp-test0000-bbbb", msg: "fake B", ts: Date.now() - 1000, sha: "", tracked: [], untracked: [], skipped: [], auto: false },
	);
	writeFileSync(stateFile, JSON.stringify(state));
	const res = await mod.restoreCheckpoint(exec, TMP, "cp-test0000");
	assert(res.ok === false && res.error.includes("ambiguous"), "ambiguous prefix refused on restore");
	let threw = false;
	try { await mod.dropCheckpoint(exec, TMP, "cp-test0000"); } catch (err) { threw = err instanceof Error && err.message.includes("ambiguous"); }
	assert(threw, "ambiguous prefix refused on drop");
	const res2 = await mod.restoreCheckpoint(exec, TMP, "cp-test0000-aaaa");
	assert(res2.ok, "exact id still restores");
	const dropped = await mod.dropCheckpoint(exec, TMP, "cp-test0000-bbbb");
	assert(dropped.length === 1 && dropped[0] === "cp-test0000-bbbb", "exact drop still works");
}

// ================= Test 20: deleted-in-snapshot restore clears the index =================
console.log("Test 20: deleted-in-snapshot restore clears worktree + index");
{
	write("gone.txt", "v1");
	git(["add", "gone.txt"]);
	git(["commit", "-qm", "add gone.txt"]);
	git(["rm", "-q", "gone.txt"]);
	const e = await mod.createCheckpoint(exec, TMP, "gone deleted", false);
	assert(e !== null && e.tracked.includes("gone.txt"), "deletion captured");
	// re-created AND staged after the checkpoint: without git rm the next
	// commit would resurrect the file
	write("gone.txt", "resurrected");
	git(["add", "gone.txt"]);
	const res = await mod.restoreCheckpoint(exec, TMP, e.id, { force: true });
	assert(res.ok && res.restored.includes("gone.txt (deleted)"), "force restore removes the file");
	assert(!existsSync(join(TMP, "gone.txt")), "worktree file gone");
	assert(git(["ls-files", "gone.txt"]).stdout.trim() === "", "index entry gone (no resurrection on commit)");
	git(["commit", "-qm", "record removal"]);
	// re-created but never staged: git rm skips it, the worktree sweep removes it
	write("gone.txt", "v2");
	git(["add", "gone.txt"]);
	git(["commit", "-qm", "re-add gone"]);
	git(["rm", "-q", "gone.txt"]);
	const e2 = await mod.createCheckpoint(exec, TMP, "gone2 deleted", false);
	write("gone.txt", "untracked resurrection");
	const res2 = await mod.restoreCheckpoint(exec, TMP, e2.id, { force: true });
	assert(res2.ok && res2.restored.includes("gone.txt (deleted)"), "untracked resurrection removed");
	assert(!existsSync(join(TMP, "gone.txt")), "untracked resurrection worktree file gone");
}

// ================= Test 21: glob chars in file names =================
console.log("Test 21: file names with glob chars handled literally");
{
	write("glob[1].txt", "g1");
	write("glob1.txt", "decoy");
	git(["add", "."]);
	git(["commit", "-qm", "add globs"]);
	write("glob[1].txt", "g2");
	write("glob1.txt", "decoy-modified");
	const e = await mod.createCheckpoint(exec, TMP, "globs", false);
	assert(e !== null && e.tracked.includes("glob[1].txt") && e.tracked.includes("glob1.txt"), "both captured");
	write("glob[1].txt", "g3"); // only the literal file changes after the checkpoint
	const res = await mod.restoreCheckpoint(exec, TMP, e.id, { force: true });
	assert(res.ok && res.restored.includes("glob[1].txt"), "literal glob-char file restored");
	assert(read("glob[1].txt") === "g2", "glob-char file reverted to snapshot");
	assert(read("glob1.txt") === "decoy-modified", "decoy file untouched (no glob over-match)");
}


rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
