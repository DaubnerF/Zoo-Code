// npx vitest src/core/task/__tests__/build-tools.spec.ts
//
// Gemini `includeAllToolsWithRestrictions` path: with the flag on, `tools`
// contains ALL declarations while `allowedFunctionNames` is derived from the
// resolver-filtered set — so a disabled `attempt_completion` is still allowed
// (protocol guarantee) and `disabledTools`-removed tools are excluded.

import type OpenAI from "openai"

import type { McpServer, ModeConfig, ModelInfo } from "@roo-code/types"

import type { ClineProvider } from "../../webview/ClineProvider"
import type { McpHub } from "../../../services/mcp/McpHub"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

// Keeps the test independent of the bundled @roo-code/core package; the
// customTools experiment stays off in every case below.
vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		loadFromDirectoriesIfStale: vi.fn(),
		getAllSerialized: () => [],
	},
	formatNative: vi.fn(),
}))

import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

/**
 * ClineProvider is a heavy class; build-tools only reads `context` and
 * `getMcpHub()` from it, so a minimal object literal stands in. The only
 * double assertions in this file.
 */
function makeProvider(servers: McpServer[] = []): ClineProvider {
	const provider = {
		context: { extensionPath: "/mock", globalStoragePath: "/mock", storagePath: "/mock", logPath: "/mock" },
		getMcpHub: () => ({ getServers: () => servers }) as unknown as McpHub,
	}
	return provider as unknown as ClineProvider
}

function toolNames(tools: OpenAI.Chat.ChatCompletionTool[]): string[] {
	return tools
		.filter((t): t is OpenAI.Chat.ChatCompletionFunctionTool => "function" in t && Boolean(t.function))
		.map((t) => t.function.name)
}

describe("buildNativeToolsArrayWithRestrictions — Gemini includeAllToolsWithRestrictions", () => {
	const provider = makeProvider()

	it("sends all declarations but restricts allowedFunctionNames (protocol tool stays allowed)", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			disabledTools: ["execute_command", "attempt_completion"],
			includeAllToolsWithRestrictions: true,
		})

		// All tools are still advertised (declarations), including the two
		// disabled ones.
		expect(toolNames(result.tools)).toContain("execute_command")
		expect(toolNames(result.tools)).toContain("attempt_completion")

		// But the logical set (allowedFunctionNames) honors the policy:
		// attempt_completion is a protocol tool and stays allowed even though
		// disabledTools lists it; execute_command is removed.
		expect(result.allowedFunctionNames).toContain("attempt_completion")
		expect(result.allowedFunctionNames).not.toContain("execute_command")
	})

	it("flows mode filtering through the resolver into allowedFunctionNames", async () => {
		const customModes: ModeConfig[] = [
			{
				slug: "arch",
				name: "Architect-ish",
				roleDefinition: "",
				groups: ["read", ["edit", { fileRegex: "\\.md$" }]],
			},
		]

		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "arch",
			customModes,
			experiments: {},
			apiConfiguration: undefined,
			includeAllToolsWithRestrictions: true,
		})

		// The mode's groups do not include "command", so execute_command is not
		// in the logical set even though it is advertised in tools.
		expect(toolNames(result.tools)).toContain("execute_command")
		expect(result.allowedFunctionNames).not.toContain("execute_command")
		// Anchor: the mode's read group is still allowed, so the list is populated.
		expect(result.allowedFunctionNames).toContain("read_file")
	})

	it("default path (flag omitted) omits disabled tools from the sent declarations", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			disabledTools: ["execute_command"],
		})

		// Non-Gemini path: disabled tools are not sent at all.
		expect(toolNames(result.tools)).not.toContain("execute_command")
		expect(result.allowedFunctionNames).toBeUndefined()
	})

	it("excludes modelInfo.excludedTools from allowedFunctionNames", async () => {
		const modelInfo: ModelInfo = {
			contextWindow: 100_000,
			supportsPromptCache: true,
			excludedTools: ["read_file"],
		}

		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			modelInfo,
			includeAllToolsWithRestrictions: true,
		})

		expect(result.allowedFunctionNames).not.toContain("read_file")
		expect(result.allowedFunctionNames).toContain("attempt_completion")
	})

	it("omits dynamic MCP declarations when disabledTools disables use_mcp_tool", async () => {
		// The builder threads disabledTools/modelInfo into the MCP filter, so a
		// disabled use_mcp_tool removes every mcp--* declaration from the sent
		// tools, and from allowedFunctionNames on the Gemini path.
		const mcpProvider = makeProvider([
			{
				name: "test-server",
				config: "{}",
				status: "connected",
				tools: [{ name: "test_tool", description: "a test tool", inputSchema: { type: "object" } }],
			},
		])

		const result = await buildNativeToolsArrayWithRestrictions({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			disabledTools: ["use_mcp_tool"],
		})

		expect(toolNames(result.tools).some((name) => name.startsWith("mcp--"))).toBe(false)

		const geminiResult = await buildNativeToolsArrayWithRestrictions({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			disabledTools: ["use_mcp_tool"],
			includeAllToolsWithRestrictions: true,
		})

		// The MCP declaration stays advertised (all tools are sent on this path)
		// but drops out of the callable allowlist.
		expect(geminiResult.allowedFunctionNames?.some((name) => name.startsWith("mcp--"))).toBe(false)
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

		const result = await buildNativeToolsArrayWithRestrictions({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
		})

		expect(toolNames(result.tools)).toContain("mcp--test-server--test_tool")
	})
})
