/**
 * unity_install_bridge tool — auto-install PiBridge into a Unity project.
 *
 * Copies the bundled PiBridge/*.cs files (sibling of this extension's index.ts)
 * into <projectPath>/Assets/Editor/PiBridge/, grouping them under a dedicated
 * subfolder so they stay together and don't collide with the user's own
 * Editor scripts. Creates Assets/Editor/PiBridge/ if missing.
 *
 * Also migrates any previous flat-layout install (older versions copied these
 * .cs directly into Assets/Editor/); left in place, those would duplicate the
 * subfolder copies and break compilation. Only files that are actually ours
 * (declare `namespace PiBridge`) are removed, so user scripts with a
 * coincidentally-matching name are never touched.
 *
 * This lets the AI set up the bridge for any Unity project on demand — the
 * user just provides the project directory and the agent handles the rest.
 * After install, Unity auto-compiles on focus and the bridge starts, after
 * which unity_command becomes usable.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";

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
	/** Stale flat-layout copies removed during this install (0 unless upgrading from an older version). */
	migratedFiles: number;
	version: string;
	nextSteps: string[];
}

// Resolve the extension's own directory at runtime so we can read the bundled
// PiBridge/*.cs files that ship alongside index.ts (in the extension root, one
// level up from this tools/ file). Under jiti __dirname points to the compiled
// file's directory, so we go up one level from tools/ to reach the extension root.
function getExtensionDir(): string {
	return resolve(__dirname, "..");
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

	// 5. Migrate any previous flat-layout install: older versions copied these
	//    .cs directly into Assets/Editor/. Left in place, they'd duplicate the
	//    subfolder copies (CS0101 duplicate definition). Remove only files that
	//    are actually ours (declare `namespace PiBridge`); this never touches a
	//    user script that merely shares a filename.
	let migratedFiles = 0;
	if (existsSync(editorDir)) {
		for (const entry of readdirSync(editorDir)) {
			if (!entry.endsWith(".cs")) continue;
			const flatPath = join(editorDir, entry);
			let content: string;
			try {
				content = readFileSync(flatPath, "utf-8");
			} catch {
				continue; // directory or unreadable — skip
			}
			if (content.includes("namespace PiBridge")) {
				try {
					unlinkSync(flatPath);
					migratedFiles++;
				} catch {
					// best-effort; a locked file will surface as a Unity compile error
				}
			}
		}
	}

	// 6. Return result with next steps for the AI/user
	return {
		projectPath,
		installedPath: bridgeDir,
		installedFiles,
		migratedFiles,
		version,
		nextSteps: [
			"Unity will auto-detect the new .cs files and recompile (may take a few seconds).",
			"If Unity is already open, it compiles on focus; if closed, it compiles on next open.",
			"Check the Unity Console for: [PiBridge] Listening on http://127.0.0.1:17841",
			"Once the bridge is running, unity_command becomes usable for this project.",
			"To verify: call unity_command with command='ping'.",
		],
	};
}
