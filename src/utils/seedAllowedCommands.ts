import * as vscode from "vscode"

import { Package } from "../shared/package"

/**
 * Seeds the extension's global-state allowlist from the `allowedCommands`
 * setting, but only when global state holds no list yet (first run).
 *
 * The seed reads the global-scope value via `inspect()` rather than the
 * effective `get()` on purpose: `get()` folds in workspace-scoped overrides,
 * so a project's `.vscode/settings.json` would otherwise be copied
 * permanently into global state the first time the extension activates inside
 * that project — a leak that survives closing the project.
 *
 * @param globalState - The extension global-state memento to seed.
 */
export async function seedAllowedCommands(globalState: vscode.Memento): Promise<void> {
	if (globalState.get("allowedCommands")) {
		return
	}

	let globalValue: string[] | undefined
	try {
		globalValue = vscode.workspace.getConfiguration(Package.name).inspect<string[]>("allowedCommands")?.globalValue
	} catch {
		// Configuration access can fail (for example before the workspace is
		// ready); skipping the seed only defers it to a later activation.
		return
	}

	// An absent global-scope value leaves global state untouched: seeding the
	// package.json default or a workspace override would defeat the point of
	// scoping the seed to the user's own settings.
	if (!Array.isArray(globalValue)) {
		return
	}

	// Copy so global state never shares a reference with the configuration object.
	await globalState.update("allowedCommands", [...globalValue])
}
