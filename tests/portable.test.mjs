// tests/portable.test.mjs
// Guard: committed code/config files must not contain machine-specific
// absolute paths (home dirs, nvm, npm global install, drive letters).
// A stale tsconfig carrying another machine's home-dir paths silently broke
// clone-and-run; this keeps that class of regression out.
// User docs (README.md, RULES.md) are exempt - they may legitimately show
// path examples. The guard file itself is exempt (it names the patterns it
// scans for).
// Usage: node tests/portable.test.mjs  (or: npm test)

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ FAIL: ${msg}`); }
}

console.log("portable: committed code/config files are free of machine-specific paths");
{
  const res = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf-8" });
  if (res.status !== 0) {
    assert(false, "git ls-files works");
  } else {
    const files = res.stdout.split("\n").filter(Boolean).filter((f) =>
      !f.endsWith(".md") && f !== ".gitignore" && f !== "tests/portable.test.mjs"
    );
    // Machine-specific path markers in source text. Windows paths appear
    // escaped in code/config ("C:\\Users\\..."), so separators allow 1-2;
    // backslash is excluded from the tail class so a bare root like "C:\\"
    // (no path after it) is not flagged.
    const markers = [
      [/\/Users\//i, "macOS home dir"],
      [/\/home\//i, "Linux home dir"],
      [/C:[\\/]{1,2}Users[\\/]/i, "Windows home dir"],
      [/\.nvm[\\/]/i, "nvm install dir"],
      [/AppData[\\/]{1,2}Roaming[\\/]npm/i, "npm global dir on Windows"],
      [/(^|[\s"'`(])[A-Za-z]:[\\/]{1,2}[^\s\\"'`()]+/, "drive-letter absolute path"],
    ];
    const found = [];
    // Read the committed (HEAD) content: the guard exists to keep machine
    // paths out of commits. Local uncommitted edits must not fail `npm test`.
    const readCommitted = (f) => {
      const r = spawnSync("git", ["cat-file", "blob", `HEAD:${f}`], { cwd: root, encoding: "utf-8" });
      return r.status === 0 ? r.stdout : readFileSync(join(root, f), "utf-8");
    };
    for (const f of files) {
      const text = readCommitted(f);
      for (const [re, label] of markers) {
        const m = text.match(re);
        if (m) found.push(`${f}: ${label} (${m[0].slice(0, 40).replace(/\n/g, "\\n")})`);
      }
    }
    assert(found.length === 0, `no machine-specific paths in ${files.length} tracked code/config files`);
    for (const s of found) console.log(`      ${s}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
