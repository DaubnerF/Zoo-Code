import type OpenAI from "openai"
import type { ModeConfig, ToolName, ToolGroup, ModelInfo } from "@roo-code/types"
import { defaultModeSlug } from "../../../shared/modes"
import { TOOL_GROUPS, ALWAYS_AVAILABLE_TOOLS, TOOL_ALIASES } from "../../../shared/tools"
import type { CodeIndexManager } from "../../../services/code-index/manager"
import type { McpHub } from "../../../services/mcp/McpHub"
import { resolveEffectiveToolPolicy, resolveToolAlias } from "./effective-tool-policy"
import { isToolAllowedForMode } from "../../../core/tools/validateToolUse"

// Re-export the resolver's alias helper so existing importers of this module
// (NativeToolCallParser, presentAssistantMessage, build-tools) keep binding to the
// single canonical implementation in effective-tool-policy.ts.
export { resolveToolAlias }

/**
 * Canonical to aliases map - maps canonical tool name to array of alias names.
 * Built once at module load from the central TOOL_ALIASES constant.
 */
const CANONICAL_TO_ALIASES: Map<string, string[]> = new Map()

// Build the reverse mapping (canonical -> aliases)
for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
	const existing = CANONICAL_TO_ALIASES.get(canonical) ?? []
	existing.push(alias)
	CANONICAL_TO_ALIASES.set(canonical, existing)
}

/**
 * Pre-computed alias groups map - maps any tool name (canonical or alias) to its full group.
 * Built once at module load for O(1) lookup.
 */
const ALIAS_GROUPS: Map<string, readonly string[]> = new Map()

// Build alias groups for all tools
for (const [canonical, aliases] of CANONICAL_TO_ALIASES.entries()) {
	const group = Object.freeze([canonical, ...aliases])
	// Map canonical to group
	ALIAS_GROUPS.set(canonical, group)
	// Map each alias to the same group
	for (const alias of aliases) {
		ALIAS_GROUPS.set(alias, group)
	}
}

/**
 * Cache for renamed tool definitions.
 * Maps "canonicalName:aliasName" to the pre-built tool definition.
 * This avoids creating new objects via spread operators on every assistant message.
 */
const RENAMED_TOOL_CACHE: Map<string, OpenAI.Chat.ChatCompletionTool> = new Map()

/**
 * Gets or creates a renamed tool definition with the alias name.
 * Uses RENAMED_TOOL_CACHE to avoid repeated object allocation.
 *
 * @param tool - The original tool definition
 * @param aliasName - The alias name to use
 * @returns Cached or newly created renamed tool definition
 */
function getOrCreateRenamedTool(
	tool: OpenAI.Chat.ChatCompletionTool,
	aliasName: string,
): OpenAI.Chat.ChatCompletionTool {
	if (!("function" in tool) || !tool.function) {
		return tool
	}

	const cacheKey = `${tool.function.name}:${aliasName}`
	let renamedTool = RENAMED_TOOL_CACHE.get(cacheKey)

	if (!renamedTool) {
		renamedTool = {
			...tool,
			function: {
				...tool.function,
				name: aliasName,
			},
		}
		RENAMED_TOOL_CACHE.set(cacheKey, renamedTool)
	}

	return renamedTool
}

/**
 * Applies tool alias resolution to a set of allowed tools.
 * Resolves any aliases to their canonical tool names.
 *
 * @param allowedTools - Set of tools that may contain aliases
 * @returns Set with aliases resolved to canonical names
 */
export function applyToolAliases(allowedTools: Set<string>): Set<string> {
	const result = new Set<string>()

	for (const tool of allowedTools) {
		// Resolve alias to canonical name
		result.add(resolveToolAlias(tool))
	}

	return result
}

/**
 * Gets all tools in an alias group (including the canonical tool).
 * Uses pre-computed ALIAS_GROUPS map for O(1) lookup.
 *
 * @param toolName - Any tool name in the alias group
 * @returns Array of all tool names in the alias group, or just the tool if not aliased
 */
export function getToolAliasGroup(toolName: string): readonly string[] {
	return ALIAS_GROUPS.get(toolName) ?? [toolName]
}

/**
 * Filters native tools based on mode restrictions and model customization.
 * This ensures native tools are filtered consistently with mode/tool permissions.
 *
 * @param nativeTools - Array of all available native tools
 * @param mode - Current mode slug
 * @param customModes - Custom mode configurations
 * @param experiments - Experiment flags
 * @param codeIndexManager - Code index manager for codebase_search feature check
 * @param settings - Additional settings for tool filtering (includes modelInfo for model-specific customization)
 * @param mcpHub - MCP hub for checking available resources
 * @param allowedMcpServers - Optional allowlist of MCP server names for the current mode. When
 *   provided, the resource-availability check only considers servers in this list, so a mode that
 *   restricts MCP servers cannot retain `access_mcp_resource` based on resources from disallowed servers.
 * @returns Filtered array of tools allowed for the mode
 */
export function filterNativeToolsForMode(
	nativeTools: OpenAI.Chat.ChatCompletionTool[],
	mode: string | undefined,
	customModes: ModeConfig[] | undefined,
	experiments: Record<string, boolean> | undefined,
	codeIndexManager?: CodeIndexManager,
	settings?: Record<string, any>,
	mcpHub?: McpHub,
	allowedMcpServers?: string[],
): OpenAI.Chat.ChatCompletionTool[] {
	// Resolve the single, request-scoped effective tool policy. The filter below
	// consumes only its `tools` set (plus alias renames from model customization),
	// so prompt generation and API tool construction agree on the logical allowed
	// set. Behavior for all non-protocol tools is byte-identical to the previous
	// inline computation; attempt_completion is always advertised (the protocol
	// guarantee), even if it appears in disabledTools.
	const modelInfo = settings?.modelInfo as ModelInfo | undefined

	const policy = resolveEffectiveToolPolicy({
		mode: mode ?? defaultModeSlug,
		customModes,
		mcpHub,
		disabledTools: settings?.disabledTools,
		modelInfo,
		experiments,
		todoListEnabled: settings?.todoListEnabled,
		codeIndexManager,
		allowedMcpServers,
	})

	// Apply model-specific alias renames (canonical -> alias) to the allowed set.
	// Included-tools customization may rename a tool to the alias the caller asked
	// for; excluded/always-available semantics are already resolved by the resolver.
	const aliasRenames = resolveModelAliasRenames(modelInfo, policy.tools)

	// Filter native tools based on the allowed tool names and apply alias renames
	const filteredTools: OpenAI.Chat.ChatCompletionTool[] = []

	for (const tool of nativeTools) {
		// Handle both ChatCompletionTool and ChatCompletionCustomTool
		if ("function" in tool && tool.function) {
			const toolName = tool.function.name
			if (policy.tools.has(resolveToolAlias(toolName))) {
				// Check if this tool should be renamed to an alias
				const aliasName = aliasRenames.get(toolName)
				if (aliasName) {
					// Use cached renamed tool definition to avoid per-message object allocation
					filteredTools.push(getOrCreateRenamedTool(tool, aliasName))
				} else {
					filteredTools.push(tool)
				}
			}
		}
	}

	return filteredTools
}

/**
 * Computes canonical -> alias renames from model-specific included-tools
 * customization, but only for tools that remain in the effective policy's allowed
 * set (exclusions are already applied by the resolver). Preserves the previous
 * behavior where an alias listed in includedTools renames the canonical tool.
 */
function resolveModelAliasRenames(
	modelInfo: ModelInfo | undefined,
	allowedTools: ReadonlySet<string>,
): Map<string, string> {
	const aliasRenames = new Map<string, string>()
	if (!modelInfo?.includedTools?.length) {
		return aliasRenames
	}
	for (const included of modelInfo.includedTools) {
		const canonical = resolveToolAlias(included)
		if (canonical !== included && allowedTools.has(canonical)) {
			aliasRenames.set(canonical, included)
		}
	}
	return aliasRenames
}

/**
 * Checks if a specific tool is allowed in the current mode.
 * This is useful for dynamically filtering system prompt content.
 *
 * @param toolName - Name of the tool to check
 * @param mode - Current mode slug
 * @param customModes - Custom mode configurations
 * @param experiments - Experiment flags
 * @param codeIndexManager - Code index manager for codebase_search feature check
 * @param settings - Additional settings for tool filtering
 * @returns true if the tool is allowed in the mode, false otherwise
 */
export function isToolAllowedInMode(
	toolName: ToolName,
	mode: string | undefined,
	customModes: ModeConfig[] | undefined,
	experiments: Record<string, boolean> | undefined,
	codeIndexManager?: CodeIndexManager,
	settings?: Record<string, any>,
): boolean {
	const modeSlug = mode ?? defaultModeSlug

	// Check if it's an always-available tool
	if (ALWAYS_AVAILABLE_TOOLS.includes(toolName)) {
		// But still check for conditional exclusions
		if (toolName === "codebase_search") {
			return !!(
				codeIndexManager &&
				codeIndexManager.isFeatureEnabled &&
				codeIndexManager.isFeatureConfigured &&
				codeIndexManager.isInitialized
			)
		}
		if (toolName === "update_todo_list") {
			return settings?.todoListEnabled !== false
		}
		if (toolName === "generate_image") {
			return experiments?.imageGeneration === true
		}
		if (toolName === "run_slash_command") {
			return experiments?.runSlashCommand === true
		}
		return true
	}

	// Check if the tool is allowed by the mode's groups
	// Resolve to canonical name and check that single value
	const canonicalTool = resolveToolAlias(toolName)
	return isToolAllowedForMode(
		canonicalTool as ToolName,
		modeSlug,
		customModes ?? [],
		undefined,
		undefined,
		experiments ?? {},
	)
}

/**
 * Gets the list of available tools from a specific tool group for the current mode.
 * This is useful for dynamically building system prompt content based on available tools.
 *
 * @param groupName - Name of the tool group to check
 * @param mode - Current mode slug
 * @param customModes - Custom mode configurations
 * @param experiments - Experiment flags
 * @param codeIndexManager - Code index manager for codebase_search feature check
 * @param settings - Additional settings for tool filtering
 * @returns Array of tool names that are available from the group
 */
export function getAvailableToolsInGroup(
	groupName: ToolGroup,
	mode: string | undefined,
	customModes: ModeConfig[] | undefined,
	experiments: Record<string, boolean> | undefined,
	codeIndexManager?: CodeIndexManager,
	settings?: Record<string, any>,
): ToolName[] {
	const toolGroup = TOOL_GROUPS[groupName]
	if (!toolGroup) {
		return []
	}

	return toolGroup.tools.filter((tool) =>
		isToolAllowedInMode(tool as ToolName, mode, customModes, experiments, codeIndexManager, settings),
	) as ToolName[]
}

/**
 * Filters MCP tools based on whether use_mcp_tool is allowed in the current mode.
 *
 * @param mcpTools - Array of MCP tools
 * @param mode - Current mode slug
 * @param customModes - Custom mode configurations
 * @param experiments - Experiment flags
 * @returns Filtered array of MCP tools if use_mcp_tool is allowed, empty array otherwise
 */
export function filterMcpToolsForMode(
	mcpTools: OpenAI.Chat.ChatCompletionTool[],
	mode: string | undefined,
	customModes: ModeConfig[] | undefined,
	experiments: Record<string, boolean> | undefined,
): OpenAI.Chat.ChatCompletionTool[] {
	const modeSlug = mode ?? defaultModeSlug

	// MCP tools are always in the mcp group, check if use_mcp_tool is allowed
	const isMcpAllowed = isToolAllowedForMode(
		"use_mcp_tool",
		modeSlug,
		customModes ?? [],
		undefined,
		undefined,
		experiments ?? {},
	)

	return isMcpAllowed ? mcpTools : []
}
