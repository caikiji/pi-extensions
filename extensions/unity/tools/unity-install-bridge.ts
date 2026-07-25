/**
 * unity_install_bridge tool — auto-install PiBridge.cs into a Unity project.
 *
 * Copies the bundled PiBridge.cs (sibling of this extension's index.ts) into
 * <projectPath>/Assets/Editor/PiBridge.cs. Creates Assets/Editor/ if missing.
 *
 * This lets the AI set up the bridge for any Unity project on demand — the
 * user just provides the project directory and the agent handles the rest.
 * After install, Unity auto-compiles on focus and the bridge starts, after
 * which unity_command becomes usable.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";

export const unityInstallBridgeParams = Type.Object({
	projectPath: Type.String({
		description:
			"Path to the Unity project root (the folder containing Assets/ and ProjectSettings/). The bridge will be installed to <projectPath>/Assets/Editor/PiBridge.cs.",
	}),
	overwrite: Type.Optional(
		Type.Boolean({
			description: "If PiBridge.cs already exists, overwrite it. Default false (backs up the existing file to PiBridge.cs.bak first).",
		}),
	),
});

export interface UnityInstallBridgeParams {
	projectPath: string;
	overwrite?: boolean;
}

export interface UnityInstallBridgeResult {
	projectPath: string;
	installedPath: string;
	alreadyExisted: boolean;
	backupPath?: string;
	version: string;
	nextSteps: string[];
}

// Resolve the extension's own directory at runtime so we can read the bundled
// PiBridge.cs that ships alongside index.ts (in the extension root, one level
// up from this tools/ file). Under jiti __dirname points to the compiled file's
// directory, so we go up one level from tools/ to reach the extension root.
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

	// 2. Locate the bundled PiBridge.cs
	const extensionDir = getExtensionDir();
	const bridgeSource = join(extensionDir, "PiBridge.cs");
	if (!existsSync(bridgeSource)) {
		throw new Error(
			`Bundled PiBridge.cs not found at: ${bridgeSource}\n` +
				"The extension installation may be incomplete.",
		);
	}
	const bridgeContent = readFileSync(bridgeSource, "utf-8");

	// Extract version from the source for reporting
	const versionMatch = bridgeContent.match(/BridgeVersion\s*=\s*"([^"]+)"/);
	const version = versionMatch ? versionMatch[1] : "unknown";

	// 3. Ensure Assets/Editor/ exists
	const editorDir = join(projectPath, "Assets", "Editor");
	mkdirSync(editorDir, { recursive: true });

	// 4. Handle existing PiBridge.cs
	const targetPath = join(editorDir, "PiBridge.cs");
	let alreadyExisted = false;
	let backupPath: string | undefined;

	if (existsSync(targetPath)) {
		alreadyExisted = true;
		if (!params.overwrite) {
			// Back up the existing file before overwriting
			backupPath = targetPath + ".bak";
			renameSync(targetPath, backupPath);
		}
	}

	// 5. Write the bridge file
	writeFileSync(targetPath, bridgeContent, "utf-8");

	// 6. Return result with next steps for the AI/user
	return {
		projectPath,
		installedPath: targetPath,
		alreadyExisted,
		backupPath,
		version,
		nextSteps: [
			"Unity will auto-detect the new .cs file and recompile (may take a few seconds).",
			"If Unity is already open, it compiles on focus; if closed, it compiles on next open.",
			"Check the Unity Console for: [PiBridge] Listening on http://127.0.0.1:17841",
			"Once the bridge is running, unity_command becomes usable for this project.",
			"To verify: call unity_command with command='ping'.",
		],
	};
}
