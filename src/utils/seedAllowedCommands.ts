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

	// Only the configuration lookup itself is guarded: it can fail (for example
	// before the workspace is ready), and skipping the seed then only defers it
	// to a later activation. The `?.globalValue` read below stays outside the
	// guarded region so a genuine lookup failure stays distinguishable from an
	// absent value rather than being swallowed as one.
	let inspected: { globalValue?: string[] } | undefined
	try {
		inspected = vscode.workspace.getConfiguration(Package.name).inspect<string[]>("allowedCommands")
	} catch {
		return
	}

	// An absent global-scope value leaves global state untouched: seeding the
	// package.json default or a workspace override would defeat the point of
	// scoping the seed to the user's own settings.
	const globalValue = inspected?.globalValue
	if (!Array.isArray(globalValue)) {
		return
	}

	// Copy so global state never shares a reference with the configuration object.
	await globalState.update("allowedCommands", [...globalValue])
}
