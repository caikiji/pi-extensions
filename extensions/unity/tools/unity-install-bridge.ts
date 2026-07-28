/**
 * unity_install_bridge tool — auto-install PiBridge into a Unity project.
 *
 * Copies the bundled PiBridge/*.cs files (sibling of this extension's index.ts)
 * into <projectPath>/Assets/Editor/PiBridge/, grouping them under a dedicated
 * subfolder so they stay together and don't collide with the user's own
 * Editor scripts. Creates Assets/Editor/PiBridge/ if missing.
 *
 * Also copies the Roslyn C# scripting DLLs (PiBridge/Roslyn/<version>/) matching
 * the project's Unity version into Assets/Editor/PiBridge/Roslyn/. These are
 * required by the `eval` command's Roslyn-backed CSharpScript runner — without
 * them, PiBridge.cs would fail to compile. Version selection:
 *   2019.x / 2020.x  -> Roslyn v3.11.0 (C# 7.3/8.0)
 *   2021.x / 2022.x  -> Roslyn v4.0.1  (C# 9.0)   [Tuanjie forks map by year too]
 *   Unity 6 (6000.x) -> Roslyn v4.8.0  (C# 10+)
 *   older/unknown    -> no Roslyn copied; eval will report a load error on use
 *
 * This lets the AI set up the bridge for any Unity project on demand — the
 * user just provides the project directory and the agent handles the rest.
 * After install, Unity auto-compiles on focus and the bridge starts, after
 * which unity_command becomes usable.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { parseUnityVersion, readProjectVersion } from "../lib/project-version.ts";

export const unityInstallBridgeParams = Type.Object({
	projectPath: Type.String({
		description:
			"Path to the Unity project root (the folder containing Assets/ and ProjectSettings/). The bridge files will be installed to <projectPath>/Assets/Editor/PiBridge/.",
	}),
});

export interface UnityInstallBridgeParams {
	projectPath: string;
}

export interface UnityInstallBridgeResult {
	projectPath: string;
	installedPath: string;
	installedFiles: string[];
	version: string;
	roslynVersion: string | null;
	roslynDllsCopied: number;
	nextSteps: string[];
}

// Resolve the extension's own directory at runtime so we can read the bundled
// PiBridge/*.cs files that ship alongside index.ts (in the extension root, one
// level up from this tools/ file). Under jiti __dirname points to the compiled
// file's directory, so we go up one level from tools/ to reach the extension root.
function getExtensionDir(): string {
	return resolve(__dirname, "..");
}

/**
 * Map a Unity version (e.g. "2022.3.62t7", "6000.0.2f1", "2019.4.40f1") to the
 * bundled Roslyn folder name that ships under PiBridge/Roslyn/, or null if
 * no matching Roslyn set exists (e.g. Unity older than 2019.4, which is
 * unsupported). Tuanjie forks (suffix "t<N>") map by the underlying year.
 */
export function roslynVersionForUnity(unityVersion: string | null): string | null {
	if (!unityVersion) return null;
	const parsed = parseUnityVersion(unityVersion);
	const major = parsed?.major ?? Number.parseInt(unityVersion.split(".")[0] ?? "0", 10);
	if (!Number.isFinite(major) || major <= 0) return null;
	if (major >= 6000) return "v4.8.0"; // Unity 6 / Tuanjie 6
	if (major >= 2021) return "v4.0.1"; // 2021.x / 2022.x (incl. Tuanjie)
	if (major >= 2019) return "v3.11.0"; // 2019.4 / 2020.3 LTS
	return null; // older than 2019.4 — unsupported, no Roslyn set shipped
}

export async function runUnityInstallBridge(
	params: UnityInstallBridgeParams,
): Promise<UnityInstallBridgeResult> {
	const projectPath = resolve(params.projectPath);

	// 1. Validate it's a Unity project
	if (!existsSync(join(projectPath, "ProjectSettings"))) {
		throw new Error(
			`Not a Unity project (no ProjectSettings/ folder): ${projectPath}\n` +
				"A Unity project root must contain ProjectSettings/ and Assets/.",
		);
	}

	// 2. Locate the bundled PiBridge source directory
	const extensionDir = getExtensionDir();
	const bridgeSourceDir = join(extensionDir, "PiBridge");
	if (!existsSync(bridgeSourceDir)) {
		throw new Error(
			`Bundled PiBridge/ directory not found at: ${bridgeSourceDir}\n` +
				"The extension installation may be incomplete.",
		);
	}
	const sourceFiles = readdirSync(bridgeSourceDir).filter((f) => f.endsWith(".cs"));
	if (sourceFiles.length === 0) {
		throw new Error(`No .cs files found in ${bridgeSourceDir}`);
	}

	// Extract version from BridgeVersion.cs (single source of truth) for reporting
	const versionSource = join(bridgeSourceDir, "BridgeVersion.cs");
	const versionContent = existsSync(versionSource) ? readFileSync(versionSource, "utf-8") : "";
	const versionMatch = versionContent.match(/Value\s*=\s*"([^"]+)"/);
	const version = versionMatch ? versionMatch[1] : "unknown";

	// 3. Ensure Assets/Editor/PiBridge/ exists. Unity compiles any .cs under an
	//    Editor/ folder (at any depth) into the editor assembly, so a subfolder
	//    behaves identically while keeping the bridge files grouped.
	const editorDir = join(projectPath, "Assets", "Editor");
	const bridgeDir = join(editorDir, "PiBridge");
	mkdirSync(bridgeDir, { recursive: true });

	// 4. Copy each .cs file into the subfolder, overwriting any existing file
	const installedFiles: string[] = [];
	for (const file of sourceFiles) {
		const targetPath = join(bridgeDir, file);
		const content = readFileSync(join(bridgeSourceDir, file), "utf-8");
		writeFileSync(targetPath, content, "utf-8");
		installedFiles.push(targetPath);
	}

	// 5. Copy the Roslyn C# scripting DLLs matching this project's Unity version.
	//    Required by the `eval` command — without them PiBridge.cs would fail to
	//    compile (RoslynEval.cs references Microsoft.CodeAnalysis.CSharp.Scripting).
	//    Each version folder under PiBridge/Roslyn/<v>/ holds the netstandard2.0
	//    DLLs that load on Unity's Mono runtime. If no set matches (very old Unity),
	//    skip the copy; the bridge still compiles because RoslynEval's types would
	//    be unresolvable — but we surface that as a next-step note, not a hard fail,
	//    so non-eval users on unsupported Unity can still use the rest of the bridge
	//    once they remove RoslynEval.cs (edge case, documented in README).
	const unityVersion = readProjectVersion(projectPath);
	const roslynVersion = roslynVersionForUnity(unityVersion);
	let roslynDllsCopied = 0;
	if (roslynVersion) {
		const roslynSourceDir = join(bridgeSourceDir, "Roslyn", roslynVersion);
		if (existsSync(roslynSourceDir)) {
			const roslynTargetDir = join(bridgeDir, "Roslyn");
			mkdirSync(roslynTargetDir, { recursive: true });
			// Wipe stale DLLs from a previously-installed different Roslyn version so
			// Unity doesn't try to load two versions of Microsoft.CodeAnalysis.
			for (const old of readdirSync(roslynTargetDir).filter((f) => f.endsWith(".dll"))) {
				try {
					unlinkSync(join(roslynTargetDir, old));
				} catch {
					// best-effort; a locked file just gets overwritten below
				}
			}
			for (const dll of readdirSync(roslynSourceDir).filter((f) => f.endsWith(".dll"))) {
				const src = join(roslynSourceDir, dll);
				const dst = join(roslynTargetDir, dll);
				copyFileSync(src, dst);
				installedFiles.push(dst);
				roslynDllsCopied++;
			}
		}
	}
	// 6. Return result with next steps for the AI/user
	const nextSteps: string[] = [
		"Unity will auto-detect the new .cs files and recompile (may take a few seconds; Roslyn DLLs are ~5-8MB).",
		"If Unity is already open, it compiles on focus; if closed, it compiles on next open.",
		"Check the Unity Console for: [PiBridge] Listening on http://127.0.0.1:17841",
		"Once the bridge is running, unity_command becomes usable for this project.",
		"To verify: call unity_command with command='ping'.",
	];
	if (!roslynVersion) {
		nextSteps.push(
			"⚠ No matching Roslyn DLL set for this Unity version — the `eval` command will be unavailable."
			+ " Other bridge commands still work. See extensions/unity/PiBridge/Roslyn/README.md.",
		);
	} else if (roslynDllsCopied === 0) {
		nextSteps.push(
			"⚠ Roslyn version " + roslynVersion + " was selected but no DLLs were copied — the extension install is incomplete. Reinstall.",
		);
	} else {
		nextSteps.push(
			`eval is ready: Roslyn ${roslynVersion} (${roslynDllsCopied} DLLs) copied — eval is enabled by default (no opt-in env var needed).`
		);
	}

	return {
		projectPath,
		installedPath: bridgeDir,
		installedFiles,
		version,
		roslynVersion,
		roslynDllsCopied,
		nextSteps,
};
}
