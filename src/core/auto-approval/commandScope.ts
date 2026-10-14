import * as vscode from "vscode"

import { Package } from "../../shared/package"

export type CommandListConfigKey = "allowedCommands" | "deniedCommands"

export interface CommandListScopes {
	global: string[]
	workspace: string[]
	merged: string[]
}

/**
 * Reads an auto-approval command list from both configuration layers and
 * composes the list that should be enforced and displayed.
 *
 * The workspace layer is read via `inspect()` rather than `get()` on purpose:
 * `get()` returns the effective value, which already folds `globalValue` into
 * the result. Unioning that with the global layer would double-count entries
 * and make removals from global settings unable to shrink the enforced set.
 *
 * @param configKey - The extension configuration key to read.
 * @param globalList - The list persisted in extension global state.
 * @returns The per-layer lists and their deduplicated set union.
 */
export function readCommandListScopes(
	configKey: CommandListConfigKey,
	globalList: string[] | undefined,
): CommandListScopes {
	const global = sanitizeCommandList(globalList)
	let workspace: string[] = []

	try {
		const inspected = vscode.workspace.getConfiguration(Package.name).inspect(configKey)
		// The folder value wins over the workspace value, matching VS Code's own
		// resolution precedence for multi-root workspaces.
		workspace = sanitizeCommandList(inspected?.workspaceFolderValue ?? inspected?.workspaceValue)
	} catch {
		// Configuration access can fail (for example before the workspace is
		// ready); an absent workspace layer must not break enforcement.
		workspace = []
	}

	// Set union: an entry present in both layers collapses to one, so
	// composition cannot change prefix-match outcomes.
	const merged = [...new Set([...global, ...workspace])]

	return { global, workspace, merged }
}

export interface CommandListWriteScopes {
	globalWrite: string[]
	workspaceWrite: string[]
}

/**
 * Splits the merged command list the settings dialog saves back into the two
 * configuration layers it was composed from, so saving the dialog cannot
 * flatten workspace-scoped entries into the user's global settings.
 *
 * Semantics:
 * - An entry the user kept that exists in the workspace layer stays in the
 *   workspace layer. If the same entry also exists in the global layer it
 *   stays there too: dropping it from the global write would silently delete
 *   a user's global entry just because the current folder happens to define
 *   it as well.
 * - An entry the user removed is dropped from every layer that contained it,
 *   which makes workspace-scoped entries deletable from the dialog.
 * - A brand-new entry (in neither layer) lands in the global layer, matching
 *   the pre-existing behavior of routing dialog edits to
 *   `ConfigurationTarget.Global`.
 *
 * @param incoming - The full merged list sent by the webview on save.
 * @param workspaceLayer - The current workspace-scope configuration value.
 * @param globalLayer - The list currently persisted in extension global state.
 * @returns The per-layer values to write back.
 */
export function splitCommandListScopes(
	incoming: string[],
	workspaceLayer: string[],
	globalLayer: string[],
): CommandListWriteScopes {
	const kept = new Set(sanitizeCommandList(incoming))
	const workspace = sanitizeCommandList(workspaceLayer)
	const global = sanitizeCommandList(globalLayer)
	const known = new Set([...workspace, ...global])

	// Deduplicated so re-writing a layer cannot introduce duplicates.
	const workspaceWrite = [...new Set(workspace.filter((command) => kept.has(command)))]
	const globalWrite = [
		...new Set(global.filter((command) => kept.has(command))),
		// Preserve the dialog's ordering for entries the user just added.
		...[...kept].filter((command) => !known.has(command)),
	]

	return { globalWrite, workspaceWrite }
}

/**
 * Picks the configuration target that owns the current workspace-scope layer
 * for `configKey`, mirroring how `readCommandListScopes` reads it via an
 * unscoped `getConfiguration(Package.name)` (which resolves folder values
 * from the first workspace folder).
 *
 * - `workspaceFolderValue` set -> write at `WorkspaceFolder` scope.
 * - Otherwise `workspaceValue` set -> write at `Workspace` scope.
 * - Neither set -> `undefined`: no workspace layer exists, so none should be
 *   created (an empty workspace layer must not materialize in settings.json).
 *
 * @param configKey - The extension configuration key to inspect.
 * @returns The workspace-scoped target to write, or `undefined` when no
 * workspace layer exists.
 */
export function resolveWorkspaceWriteTarget(
	configKey: CommandListConfigKey,
): vscode.ConfigurationTarget.WorkspaceFolder | vscode.ConfigurationTarget.Workspace | undefined {
	try {
		const inspected = vscode.workspace.getConfiguration(Package.name).inspect(configKey)
		if (inspected?.workspaceFolderValue !== undefined) {
			return vscode.ConfigurationTarget.WorkspaceFolder
		}
		if (inspected?.workspaceValue !== undefined) {
			return vscode.ConfigurationTarget.Workspace
		}
		return undefined
	} catch {
		// Same defensive posture as readCommandListScopes: configuration
		// access failures mean we create no workspace layer.
		return undefined
	}
}

function sanitizeCommandList(list: unknown): string[] {
	if (!Array.isArray(list)) {
		return []
	}

	return list.filter((command): command is string => typeof command === "string" && command.trim().length > 0)
}
