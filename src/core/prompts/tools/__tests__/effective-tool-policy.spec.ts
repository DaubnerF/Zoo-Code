import type { ModeConfig, ModelInfo } from "@roo-code/types"

import type { EffectiveToolPolicy } from "../effective-tool-policy"
import { PROTOCOL_TOOLS, resolveEffectiveToolPolicy, buildToolRequirements } from "../effective-tool-policy"
import { getModeBySlug, defaultModeSlug } from "../../../../shared/modes"
import type { McpHub } from "../../../../services/mcp/McpHub"
import type { CodeIndexManager } from "../../../../services/code-index/manager"

/** Build a policy by giving the custom mode `groups` (derived from a real custom mode config). */
function policyFor(
	groups: ModeConfig["groups"],
	extra: Partial<{
		mcpHub: McpHub
		disabledTools: string[]
		modelInfo: ModelInfo
		experiments: Record<string, boolean>
		todoListEnabled: boolean
		codeIndexManager: CodeIndexManager
		allowedMcpServers: string[]
	}> = {},
): EffectiveToolPolicy {
	const customMode: ModeConfig = {
		slug: "policy-test",
		name: "Policy Under Test",
		roleDefinition: "",
		groups,
	}
	return resolveEffectiveToolPolicy({
		mode: "policy-test",
		customModes: [customMode],
		...extra,
	})
}

/** Minimal McpHub stub. Mirrors the McpServer shape the resolver reads (getServers, resources). */
function makeMcpHub(servers: Array<{ name: string; resources?: unknown[]; tools?: unknown[] }>): McpHub {
	return { getServers: () => servers } as unknown as McpHub
}

/** CodeIndexManager stub with all "ready" flags true. */
function enabledCodeIndexManager(): CodeIndexManager {
	return { isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true } as CodeIndexManager
}

/** Build a ModelInfo satisfying the required schema fields, merged with test-specific overrides. */
function modelInfo(partial?: Partial<ModelInfo>): ModelInfo {
	return { contextWindow: 100_000, supportsPromptCache: true, ...partial }
}

describe("resolveEffectiveToolPolicy - groups", () => {
	it("grants read-group tools for a read mode", () => {
		const policy = policyFor(["read"])
		expect(policy.tools.has("read_file")).toBe(true)
		expect(policy.tools.has("codebase_search")).toBe(false) // gated by code index, off by default
		expect(policy.tools.has("list_files")).toBe(true)
		expect(policy.tools.has("search_files")).toBe(true)
	})

	it("grants edit-group tools for an edit mode", () => {
		const policy = policyFor(["edit"])
		expect(policy.tools.has("write_to_file")).toBe(true)
		expect(policy.tools.has("apply_diff")).toBe(true)
	})

	it("grants command-group tools for a command mode", () => {
		const policy = policyFor(["command"])
		expect(policy.tools.has("execute_command")).toBe(true)
		expect(policy.tools.has("read_command_output")).toBe(true)
	})

	it("combines groups", () => {
		const policy = policyFor(["read", "edit", "command"])
		expect(policy.tools.has("read_file")).toBe(true)
		expect(policy.tools.has("write_to_file")).toBe(true)
		expect(policy.tools.has("execute_command")).toBe(true)
	})

	it("keeps always-available tools regardless of groups", () => {
		const policy = policyFor([])
		// switch_mode/new_task are in the "modes" group but also always-available
		expect(policy.tools.has("ask_followup_question")).toBe(true)
		expect(policy.tools.has("update_todo_list")).toBe(true)
		expect(policy.tools.has("skill")).toBe(true)
		// run_slash_command is always-available but gated by the runSlashCommand experiment (plan step 8)
		expect(policy.tools.has("run_slash_command")).toBe(false)
	})

	it("sets hasMcpGroup only when the mode has the mcp group", () => {
		expect(policyFor(["mcp"]).hasMcpGroup).toBe(true)
		expect(policyFor(["read"]).hasMcpGroup).toBe(false)
	})

	it("extracts the first edit-restriction tuple with fileRegex", () => {
		const policy = policyFor(["read", ["edit", { fileRegex: "\\.md$", description: "Markdown files only" }]])
		expect(policy.editRestriction).toEqual({ fileRegex: "\\.md$", description: "Markdown files only" })
	})

	it("returns undefined editRestriction when no edit tuple has a fileRegex", () => {
		expect(policyFor(["edit"]).editRestriction).toBeUndefined()
	})
})

describe("resolveEffectiveToolPolicy - disabledTools", () => {
	it("removes tools listed in disabledTools (canonical)", () => {
		const policy = policyFor(["read", "edit", "command"], { disabledTools: ["execute_command"] })
		expect(policy.tools.has("execute_command")).toBe(false)
		expect(policy.tools.has("read_file")).toBe(true)
	})

	it("removes tools by alias (alias normalization)", () => {
		const policy = policyFor(["edit"], { disabledTools: ["write_file"] })
		expect(policy.tools.has("write_to_file")).toBe(false)
	})

	it("does not remove the protocol guarantee", () => {
		expect(
			policyFor(["read", "edit", "command"], { disabledTools: [...PROTOCOL_TOOLS] }).tools.has(
				"attempt_completion",
			),
		).toBe(true)
	})
})

describe("resolveEffectiveToolPolicy - model customization", () => {
	it("removes tools in modelInfo.excludedTools", () => {
		const policy = policyFor(["read", "edit", "command"], {
			modelInfo: modelInfo({ excludedTools: ["read_file"] }),
		})
		expect(policy.tools.has("read_file")).toBe(false)
	})

	it("removes tools by excludedTools alias", () => {
		const policy = policyFor(["edit"], { modelInfo: modelInfo({ excludedTools: ["write_file"] }) })
		expect(policy.tools.has("write_to_file")).toBe(false)
	})

	it("re-adds excludedTools that are protocol tools", () => {
		const policy = policyFor(["read", "edit", "command"], {
			modelInfo: modelInfo({ excludedTools: ["attempt_completion"] }),
		})
		expect(policy.tools.has("attempt_completion")).toBe(true)
	})

	it("adds includedTools only when their group is allowed", () => {
		// read group is allowed; codebase_search is in read.
		const policy = policyFor(["read"], {
			modelInfo: modelInfo({ excludedTools: [], includedTools: ["codebase_search"] }),
			codeIndexManager: enabledCodeIndexManager(),
		})
		expect(policy.tools.has("codebase_search")).toBe(true)
	})

	it("ignores includedTools outside the allowed group", () => {
		// command group only; codebase_search is in read -> not added even when requested.
		const policy = policyFor(["command"], { modelInfo: modelInfo({ includedTools: ["read_file"] }) })
		expect(policy.tools.has("read_file")).toBe(false)
	})
})

describe("resolveEffectiveToolPolicy - conditional gates", () => {
	it("drops codebase_search unless the code index is enabled/configured/initialized", () => {
		const modeWithIndex = policyFor(["read"], { codeIndexManager: enabledCodeIndexManager() })
		expect(modeWithIndex.tools.has("codebase_search")).toBe(true)

		const modeWithoutIndex = policyFor(["read"])
		expect(modeWithoutIndex.tools.has("codebase_search")).toBe(false)
	})

	it("drops update_todo_list when todoListEnabled is false", () => {
		expect(policyFor(["read", "edit", "command"], { todoListEnabled: false }).tools.has("update_todo_list")).toBe(
			false,
		)
		expect(policyFor(["read", "edit", "command"], { todoListEnabled: true }).tools.has("update_todo_list")).toBe(
			true,
		)
	})

	it("drops generate_image unless the imageGeneration experiment is enabled", () => {
		expect(
			policyFor(["read", "edit", "command"], { experiments: { imageGeneration: true } }).tools.has(
				"generate_image",
			),
		).toBe(true)
		expect(policyFor(["read", "edit", "command"]).tools.has("generate_image")).toBe(false)
	})

	it("drops run_slash_command unless the runSlashCommand experiment is enabled", () => {
		expect(
			policyFor(["read", "edit", "command"], { experiments: { runSlashCommand: true } }).tools.has(
				"run_slash_command",
			),
		).toBe(true)
		expect(policyFor(["read", "edit", "command"]).tools.has("run_slash_command")).toBe(false)
	})
})

describe("resolveEffectiveToolPolicy - MCP resource gate", () => {
	it("keeps access_mcp_resource iff an allowed server exposes resources", () => {
		const hasResources = policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s", resources: [{ uri: "r" }] }]) })
		expect(hasResources.tools.has("access_mcp_resource")).toBe(true)

		const noResources = policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s" }]) })
		expect(noResources.tools.has("access_mcp_resource")).toBe(false)
	})

	it("respects an explicit allowlist over the mode-config allowlist", () => {
		const allowed = policyFor(["mcp"], {
			mcpHub: makeMcpHub([{ name: "allowed", resources: [{ uri: "r" }] }]),
			allowedMcpServers: ["allowed"],
		})
		expect(allowed.tools.has("access_mcp_resource")).toBe(true)

		const wrongAllow = policyFor(["mcp"], {
			mcpHub: makeMcpHub([{ name: "allowed", resources: [{ uri: "r" }] }]),
			allowedMcpServers: ["blocked"],
		})
		expect(wrongAllow.tools.has("access_mcp_resource")).toBe(false)
	})

	it("falls back to the mode config allowlist when no explicit allowlist is provided", () => {
		const customMode: ModeConfig = {
			slug: "policy-test",
			name: "Restricted Mode",
			roleDefinition: "",
			groups: ["mcp"],
			allowedMcpServers: ["blocked"],
		}
		const policy = resolveEffectiveToolPolicy({
			mode: "policy-test",
			customModes: [customMode],
			mcpHub: makeMcpHub([{ name: "allowed", resources: [{ uri: "r" }] }]),
		})
		expect(policy.tools.has("access_mcp_resource")).toBe(false)
	})

	it("computes hasMcpTools from effective enabled tools and hasMcpResources from resources", () => {
		const hasToolsOnly = policyFor(["mcp"], {
			mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", description: "d" }] }]),
		})
		expect(hasToolsOnly.hasMcpTools).toBe(true)
		expect(hasToolsOnly.hasMcpResources).toBe(false)

		const hasResourcesOnly = policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s", resources: [{ uri: "r" }] }]) })
		expect(hasResourcesOnly.hasMcpTools).toBe(false)
		expect(hasResourcesOnly.hasMcpResources).toBe(true)

		const hasNeither = policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s" }]) })
		expect(hasNeither.hasMcpTools).toBe(false)
		expect(hasNeither.hasMcpResources).toBe(false)
	})
})

describe("resolveEffectiveToolPolicy - worst case (control-tools-only mode)", () => {
	it("only exposes always-available + protocol tools when groups is empty", () => {
		const policy = policyFor([])
		expect(policy.tools.has("read_file")).toBe(false)
		expect(policy.tools.has("write_to_file")).toBe(false)
		expect(policy.tools.has("execute_command")).toBe(false)
		expect(policy.tools.has("attempt_completion")).toBe(true) // protocol guarantee
		expect(policy.tools.has("switch_mode")).toBe(true) // always-available
	})
})

describe("buildToolRequirements", () => {
	it("returns an empty map when disabledTools is undefined or empty", () => {
		expect(buildToolRequirements(undefined)).toEqual({})
		expect(buildToolRequirements([])).toEqual({})
	})

	it("maps disabled tools to false (including alias + canonical)", () => {
		const reqs = buildToolRequirements(["write_file"])
		expect(reqs).toEqual({ write_file: false, write_to_file: false })
	})

	it("skips protocol tools and their aliases", () => {
		const reqs = buildToolRequirements([...PROTOCOL_TOOLS, "ask_followup_question", "switch_mode"])
		expect(Object.keys(reqs)).not.toContain("attempt_completion")
		expect(reqs).toEqual({ ask_followup_question: false, switch_mode: false })
	})

	it("adds alias + canonical for real aliases", () => {
		const reqs = buildToolRequirements(["write_file"])
		expect(Object.keys(reqs).sort()).toEqual(["write_file", "write_to_file"].sort())
	})
})
