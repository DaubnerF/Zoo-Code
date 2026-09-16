// npx vitest src/core/task/__tests__/build-tools.spec.ts
//
// Policy filtering of the sent declarations: every `disabledTools` /
// `excludedTools` entry — protocol tools included — removes the tool from the
// declarations sent to the provider. Gemini receives the same filtered list as
// every other provider.

import type OpenAI from "openai"
import type * as vscode from "vscode"

import type { McpServer, ModelInfo } from "@roo-code/types"

import type { ClineProvider } from "../../webview/ClineProvider"
import type { McpHub } from "../../../services/mcp/McpHub"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

// Keeps the test independent of the bundled @roo-code/core package. The
// customTools experiment stays off except in the project custom-tool block,
// which drives the registry mock directly.
vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		loadFromDirectoriesIfStale: vi.fn(),
		getAllSerialized: vi.fn(() => []),
		has: vi.fn(() => false),
	},
	formatNative: vi.fn((tool: { name: string; description?: string }) => ({
		type: "function",
		function: { name: tool.name, description: tool.description },
	})),
}))

import { customToolRegistry } from "@roo-code/core"

import { buildNativeToolsArray } from "../build-tools"

/**
 * ClineProvider is a heavy class; build-tools only reads `context` and
 * `getMcpHub()` from it, so a minimal object literal stands in. The double
 * declares exactly those members, narrowed via Pick to what the MCP helpers
 * actually call. ClineProvider itself structurally satisfies this shape, so
 * handing the double off as ClineProvider is a single legal assertion.
 */
type ProviderDouble = {
	context: Pick<vscode.ExtensionContext, "extensionPath" | "globalStoragePath" | "storagePath" | "logPath">
	getMcpHub: () => Pick<McpHub, "getServers"> | undefined
}

function makeProvider(servers: McpServer[] = []): ClineProvider {
	const provider: ProviderDouble = {
		context: { extensionPath: "/mock", globalStoragePath: "/mock", storagePath: "/mock", logPath: "/mock" },
		getMcpHub: () => ({ getServers: () => servers }),
	}
	return provider as ClineProvider
}

function toolNames(tools: OpenAI.Chat.ChatCompletionTool[]): string[] {
	return tools
		.filter((t): t is OpenAI.Chat.ChatCompletionFunctionTool => "function" in t && Boolean(t.function))
		.map((t) => t.function.name)
}

describe("buildNativeToolsArray — sent declaration filtering", () => {
	const provider = makeProvider()

	it("omits disabled tools from the sent declarations", async () => {
		const result = await buildNativeToolsArray({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			disabledTools: ["execute_command", "attempt_completion"],
		})

		expect(toolNames(result)).not.toContain("execute_command")
		expect(toolNames(result)).not.toContain("attempt_completion")
	})

	it("omits modelInfo.excludedTools from the sent declarations", async () => {
		const modelInfo: ModelInfo = {
			contextWindow: 100_000,
			supportsPromptCache: true,
			excludedTools: ["read_file"],
		}

		const result = await buildNativeToolsArray({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			modelInfo,
		})

		expect(toolNames(result)).not.toContain("read_file")
		expect(toolNames(result)).toContain("attempt_completion")
	})

	it("omits dynamic MCP declarations when modelInfo.excludedTools excludes use_mcp_tool", async () => {
		// The builder forwards modelInfo to the MCP filter, so a model-level
		// exclusion of use_mcp_tool removes every mcp--* declaration from the
		// sent tools — exactly like the user-level disable.
		const mcpProvider = makeProvider([
			{
				name: "test-server",
				config: "{}",
				status: "connected",
				tools: [{ name: "test_tool", description: "a test tool", inputSchema: { type: "object" } }],
			},
		])
		const modelInfo: ModelInfo = {
			contextWindow: 100_000,
			supportsPromptCache: true,
			excludedTools: ["use_mcp_tool"],
		}

		const result = await buildNativeToolsArray({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			modelInfo,
		})

		expect(toolNames(result).some((name) => name.startsWith("mcp--"))).toBe(false)

		// Positive control with a modelInfo present: an exclusion-free model
		// info keeps the declarations, proving the removal above comes from the
		// exclusion rather than from the modelInfo being ignored.
		const controlResult = await buildNativeToolsArray({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			modelInfo: { contextWindow: 100_000, supportsPromptCache: true },
		})

		expect(toolNames(controlResult)).toContain("mcp--test-server--test_tool")
	})

	it("omits dynamic MCP declarations when disabledTools disables use_mcp_tool", async () => {
		// The builder threads disabledTools/modelInfo into the MCP filter, so a
		// disabled use_mcp_tool removes every mcp--* declaration from the sent tools.
		const mcpProvider = makeProvider([
			{
				name: "test-server",
				config: "{}",
				status: "connected",
				tools: [{ name: "test_tool", description: "a test tool", inputSchema: { type: "object" } }],
			},
		])

		const result = await buildNativeToolsArray({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			disabledTools: ["use_mcp_tool"],
		})

		expect(toolNames(result).some((name) => name.startsWith("mcp--"))).toBe(false)
	})

	it("keeps dynamic MCP declarations when use_mcp_tool is not disabled or excluded", async () => {
		const mcpProvider = makeProvider([
			{
				name: "test-server",
				config: "{}",
				status: "connected",
				tools: [{ name: "test_tool", description: "a test tool", inputSchema: { type: "object" } }],
			},
		])

		const result = await buildNativeToolsArray({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
		})

		expect(toolNames(result)).toContain("mcp--test-server--test_tool")
	})
})

describe("buildNativeToolsArray — project custom-tool policy parity", () => {
	const provider = makeProvider()

	afterEach(() => {
		const getAllSerialized = vi.mocked(customToolRegistry.getAllSerialized)
		getAllSerialized.mockClear()
		getAllSerialized.mockReturnValue([])
	})

	it("omits a custom tool named in modelInfo.excludedTools from the sent declarations", async () => {
		vi.mocked(customToolRegistry.getAllSerialized).mockReturnValue([
			{ name: "deploy_site", description: "Deploy the project site" },
		])

		const result = await buildNativeToolsArray({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: { customTools: true },
			apiConfiguration: undefined,
			modelInfo: {
				contextWindow: 100_000,
				supportsPromptCache: true,
				excludedTools: ["deploy_site"],
			},
		})

		expect(toolNames(result)).not.toContain("deploy_site")
	})

	it("declares a registered custom tool that no list suppresses (positive control)", async () => {
		vi.mocked(customToolRegistry.getAllSerialized).mockReturnValue([
			{ name: "deploy_site", description: "Deploy the project site" },
		])

		const result = await buildNativeToolsArray({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: { customTools: true },
			apiConfiguration: undefined,
			modelInfo: { contextWindow: 100_000, supportsPromptCache: true },
		})

		expect(toolNames(result)).toContain("deploy_site")
	})
})
