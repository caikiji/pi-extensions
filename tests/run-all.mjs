#!/usr/bin/env node
// Run every test in tests/ — each *.test.mjs runs in its own process,
// so one crashing test can't take down the rest.
// Usage:  node tests/run-all.mjs [filter]      (filter = substring match on filename)

import { readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const filter = process.argv[2];

const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.mjs") && (!filter || f.includes(filter)))
  .sort();

if (files.length === 0) {
  console.log(`No test files found${filter ? ` matching "${filter}"` : ""} in tests/`);
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];

for (const f of files) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [join(here, f)], { encoding: "utf-8" });
  const ms = Date.now() - t0;
  const ok = res.status === 0;
  if (ok) passed++;
  else failed++;

  // last line of the test's own output is its "N passed, M failed" summary
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  const summary = out.split("\n").filter(Boolean).pop() ?? "";
  console.log(`${ok ? "✓" : "✗"} ${f} (${ms}ms) — ${summary}`);
  if (!ok) {
    failures.push(f);
    // show the failing tail for diagnosis
    console.log(out.split("\n").slice(-20).map((l) => `    ${l}`).join("\n"));
  }
}

// clean up test work directories
for (const d of readdirSync(here).filter((n) => n.startsWith(".work"))) {
  rmSync(join(here, d), { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed (${files.length} file${files.length > 1 ? "s" : ""})`);
if (failures.length > 0) console.log(`failed: ${failures.join(", ")}`);
process.exit(failed > 0 ? 1 : 0);
