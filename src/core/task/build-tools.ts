import path from "path"

import type OpenAI from "openai"

import type { ProviderSettings, ModeConfig, ModelInfo } from "@roo-code/types"
import { customToolRegistry, formatNative } from "@roo-code/core"

import type { ClineProvider } from "../webview/ClineProvider"
import { getRooDirectoriesForCwd } from "../../services/roo-config/index.js"
import { getModeBySlug, defaultModeSlug } from "../../shared/modes"

import { getNativeTools, getMcpServerTools } from "../prompts/tools/native-tools"
import { filterNativeToolsForMode, filterMcpToolsForMode } from "../prompts/tools/filter-tools-for-mode"
import { isToolDisabledOrExcluded } from "../prompts/tools/effective-tool-policy"

interface BuildToolsOptions {
	provider: ClineProvider
	cwd: string
	mode: string | undefined
	customModes: ModeConfig[] | undefined
	experiments: Record<string, boolean> | undefined
	apiConfiguration: ProviderSettings | undefined
	disabledTools?: string[]
	modelInfo?: ModelInfo
}

/**
 * Builds the complete tools array for native protocol requests.
 * Combines native tools and MCP tools, filtered by mode restrictions.
 * Every suppressed entry in `disabledTools` and `modelInfo.excludedTools` is
 * removed from the sent declarations; execution-time validation enforces the
 * same policy (see `buildToolRequirements` in effective-tool-policy.ts).
 *
 * @param options - Configuration options for building the tools
 * @returns Array of filtered native and MCP tools
 */
export async function buildNativeToolsArray(options: BuildToolsOptions): Promise<OpenAI.Chat.ChatCompletionTool[]> {
	const { provider, cwd, mode, customModes, experiments, apiConfiguration, disabledTools, modelInfo } = options

	const mcpHub = provider.getMcpHub()

	// Get CodeIndexManager for feature checking.
	const { CodeIndexManagerRegistry } = await import("../../services/code-index/code-index-manager-registry")
	const codeIndexManager = CodeIndexManagerRegistry.getOrCreate(provider.context, cwd)

	// Build settings object for tool filtering.
	const filterSettings = {
		todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
		disabledTools,
		modelInfo,
	}

	// Check if the model supports images for read_file tool description.
	const supportsImages = modelInfo?.supportsImages ?? false

	// Build native tools with dynamic read_file tool based on settings.
	const nativeTools = getNativeTools({
		supportsImages,
	})

	// Resolve mode config to get allowedMcpServers for MCP server filtering.
	const modeConfig = getModeBySlug(mode ?? defaultModeSlug, customModes)
	const allowedMcpServers = modeConfig?.allowedMcpServers

	// Filter native tools based on mode restrictions. The allowlist is forwarded so the
	// access_mcp_resource availability check only considers resources from allowed servers;
	// otherwise a restricted mode could still read resources from disallowed servers.
	const filteredNativeTools = filterNativeToolsForMode(
		nativeTools,
		mode,
		customModes,
		experiments,
		codeIndexManager,
		filterSettings,
		mcpHub,
		allowedMcpServers,
	)

	// Filter MCP tools based on mode restrictions and the effective tool policy:
	// the same disabledTools/modelInfo the native filter consumes also gate the
	// dynamic mcp--* declarations, which all represent use_mcp_tool.
	const mcpTools = getMcpServerTools(mcpHub, allowedMcpServers)
	const filteredMcpTools = filterMcpToolsForMode(mcpTools, mode, customModes, experiments, {
		disabledTools,
		modelInfo,
	})

	// Add custom tools if they are available and the experiment is enabled. The
	// effective suppression lists remove declarations here and drive the matching
	// execution-time requirements, so a model-excluded custom tool is neither
	// advertised nor callable. `disabledTools` is a closed built-in-name enum and
	// cannot name a custom tool; `modelInfo.excludedTools` can.
	let nativeCustomTools: OpenAI.Chat.ChatCompletionFunctionTool[] = []

	if (experiments?.customTools) {
		const toolDirs = getRooDirectoriesForCwd(cwd).map((dir) => path.join(dir, "tools"))
		await customToolRegistry.loadFromDirectoriesIfStale(toolDirs)
		nativeCustomTools = customToolRegistry
			.getAllSerialized()
			.filter((tool) => !isToolDisabledOrExcluded(tool.name, disabledTools, modelInfo))
			.map(formatNative)
	}

	return [...filteredNativeTools, ...filteredMcpTools, ...nativeCustomTools]
}
