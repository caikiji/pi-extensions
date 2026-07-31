// Regression test for extensions/checkpoint.ts.
// Creates a throwaway git repo in tests/.work and exercises the full
// snapshot / restore / drop lifecycle with real git. No network, no npm deps.
// Requires Node >= 22.18 — just run:  node tests/checkpoint.test.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

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
	const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	return { stdout: out, stderr: "", code: 0 };
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
	const e = entries[0];
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

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
