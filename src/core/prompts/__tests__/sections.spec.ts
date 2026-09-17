import { addCustomInstructions } from "../sections/custom-instructions"
import { getCapabilitiesSection } from "../sections/capabilities"
import { getRulesSection, getCommandChainOperator } from "../sections/rules"
import { McpHub } from "../../../services/mcp/McpHub"
import * as shellUtils from "../../../utils/shell"

import type { EffectiveToolPolicy } from "../tools/effective-tool-policy"

describe("addCustomInstructions", () => {
	it("adds vscode language to custom instructions", async () => {
		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/test/path",
			"test-mode",
			{ language: "fr" },
		)

		expect(result).toContain("Language Preference:")
		expect(result).toContain('You should always speak and think in the "Français" (fr) language')
	})

	it("works without vscode language", async () => {
		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/test/path",
			"test-mode",
		)

		expect(result).not.toContain("Language Preference:")
		expect(result).not.toContain("You should always speak and think in")
	})
})

describe("getCapabilitiesSection", () => {
	const cwd = "/test/path"

	it("includes standard capabilities", () => {
		const result = getCapabilitiesSection(cwd)

		expect(result).toContain("CAPABILITIES")
		expect(result).toContain("execute CLI commands")
		expect(result).toContain("list files")
		expect(result).toContain("read and write files")
	})

	const createMockMcpHub = (serverNames: string[]): McpHub =>
		({
			getServers: () => serverNames.map((name) => ({ name })),
		}) as unknown as McpHub

	it("includes MCP reference when mcpHub exposes at least one server", () => {
		const mockMcpHub = createMockMcpHub(["test-server"])
		const result = getCapabilitiesSection(cwd, mockMcpHub)

		expect(result).toContain("MCP servers")
	})

	it("excludes MCP reference when mcpHub is undefined", () => {
		const result = getCapabilitiesSection(cwd, undefined)

		expect(result).not.toContain("MCP servers")
	})

	it("excludes MCP reference when mcpHub exposes no servers", () => {
		const mockMcpHub = createMockMcpHub([])
		const result = getCapabilitiesSection(cwd, mockMcpHub)

		expect(result).not.toContain("MCP servers")
	})

	it("includes MCP reference when allowedMcpServers matches a connected server", () => {
		const mockMcpHub = createMockMcpHub(["allowed-server", "other-server"])
		const result = getCapabilitiesSection(cwd, mockMcpHub, ["allowed-server"])

		expect(result).toContain("MCP servers")
	})

	it("excludes MCP reference when allowedMcpServers is an empty array", () => {
		const mockMcpHub = createMockMcpHub(["test-server"])
		const result = getCapabilitiesSection(cwd, mockMcpHub, [])

		expect(result).not.toContain("MCP servers")
	})

	it("excludes MCP reference when allowedMcpServers matches no connected server", () => {
		const mockMcpHub = createMockMcpHub(["test-server"])
		const result = getCapabilitiesSection(cwd, mockMcpHub, ["nonexistent-server"])

		expect(result).not.toContain("MCP servers")
	})
})

describe("getRulesSection", () => {
	const cwd = "/test/path"

	it("includes standard rules", () => {
		const result = getRulesSection(cwd)

		expect(result).toContain("RULES")
		expect(result).toContain("project base directory")
		expect(result).toContain(cwd)
	})

	it("includes vendor confidentiality section when isStealthModel is true", () => {
		const settings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
			isStealthModel: true,
		}

		const result = getRulesSection(cwd, settings)

		expect(result).toContain("VENDOR CONFIDENTIALITY")
		expect(result).toContain("Never reveal the vendor or company that created you")
		expect(result).toContain("I was created by a team of developers")
		expect(result).toContain("I'm an open-source project maintained by contributors")
		expect(result).toContain("I don't have information about specific vendors")
	})

	it("excludes vendor confidentiality section when isStealthModel is false", () => {
		const settings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
			isStealthModel: false,
		}

		const result = getRulesSection(cwd, settings)

		expect(result).not.toContain("VENDOR CONFIDENTIALITY")
		expect(result).not.toContain("Never reveal the vendor or company")
	})

	it("excludes vendor confidentiality section when isStealthModel is undefined", () => {
		const settings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
		}

		const result = getRulesSection(cwd, settings)

		expect(result).not.toContain("VENDOR CONFIDENTIALITY")
		expect(result).not.toContain("Never reveal the vendor or company")
	})
})

describe("prompt section tool policy gating", () => {
	const cwd = "/test/path"

	const ALL_TOOLS = [
		"execute_command",
		"ask_followup_question",
		"attempt_completion",
		"list_files",
		"read_file",
		"write_to_file",
	]

	const policyWith = (tools: string[]): EffectiveToolPolicy => ({
		tools: new Set(tools),
		hasMcpGroup: false,
		hasMcpTools: false,
		hasMcpResources: false,
	})

	describe("getCapabilitiesSection", () => {
		it("keeps output byte-identical when every gated tool is available", () => {
			const withPolicy = getCapabilitiesSection(cwd, undefined, undefined, policyWith(ALL_TOOLS))

			expect(withPolicy).toBe(getCapabilitiesSection(cwd))
		})

		it("hides execute_command prose when execute_command is unavailable", () => {
			const tools = ALL_TOOLS.filter((tool) => tool !== "execute_command")
			const result = getCapabilitiesSection(cwd, undefined, undefined, policyWith(tools))

			expect(result).not.toContain("execute CLI commands on the user's computer")
			expect(result).not.toContain("You can use the execute_command tool")
			expect(result).toContain("list files")
		})

		it("hides ask_followup_question prose when ask_followup_question is unavailable", () => {
			const tools = ALL_TOOLS.filter((tool) => tool !== "ask_followup_question")
			const result = getCapabilitiesSection(cwd, undefined, undefined, policyWith(tools))

			expect(result).not.toContain("ask follow-up questions")
			expect(result).toContain("read and write files")
		})
	})

	describe("getRulesSection", () => {
		it("keeps output byte-identical when every gated tool is available", () => {
			const withPolicy = getRulesSection(cwd, undefined, policyWith(ALL_TOOLS))

			expect(withPolicy).toBe(getRulesSection(cwd))
		})

		it("hides execute_command prose when execute_command is unavailable", () => {
			const tools = ALL_TOOLS.filter((tool) => tool !== "execute_command")
			const result = getRulesSection(cwd, undefined, policyWith(tools))

			expect(result).not.toContain("However, commands may change directories")
			expect(result).not.toContain("Before using the execute_command tool")
			expect(result).not.toContain("When executing commands")
			expect(result).not.toContain("Before executing commands")
		})

		it("hides attempt_completion prose when attempt_completion is unavailable", () => {
			const tools = ALL_TOOLS.filter((tool) => tool !== "attempt_completion")
			const result = getRulesSection(cwd, undefined, policyWith(tools))

			expect(result).toContain("When you've completed your task, present the result to the user")
			expect(result).not.toContain("attempt_completion")
			expect(result).toContain("NEVER end your result with a question")
			expect(result).not.toContain("NEVER end attempt_completion result")
		})

		it("hides ask_followup_question prose when ask_followup_question is unavailable", () => {
			const result = getRulesSection(cwd, undefined, policyWith(["execute_command", "attempt_completion"]))

			expect(result).not.toContain("ask_followup_question tool")
			expect(result).toContain("When executing commands")
			expect(result).not.toContain("If you absolutely need to see the actual terminal output")
		})
	})
})

describe("getCommandChainOperator", () => {
	it("returns && for bash shell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for zsh shell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/zsh")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns ; for PowerShell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		expect(getCommandChainOperator()).toBe(";")
	})

	it("returns ; for PowerShell Core (pwsh)", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		expect(getCommandChainOperator()).toBe(";")
	})

	it("returns && for cmd.exe", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for Git Bash on Windows", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Program Files\\Git\\bin\\bash.exe")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for WSL bash", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		expect(getCommandChainOperator()).toBe("&&")
	})
})

describe("getRulesSection shell-aware command chaining", () => {
	const cwd = "/test/path"

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("uses && for Unix shells in command chaining example", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		const result = getRulesSection(cwd)

		expect(result).toContain("cd (path to project) && (command")
		expect(result).not.toContain("cd (path to project) ; (command")
		expect(result).not.toContain("cd (path to project) & (command")
	})

	it("uses ; for PowerShell in command chaining example", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		const result = getRulesSection(cwd)

		expect(result).toContain("cd (path to project) ; (command")
		expect(result).toContain("Note: Using `;` for PowerShell command chaining")
	})

	it("uses && for cmd.exe in command chaining example", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		const result = getRulesSection(cwd)

		expect(result).toContain("cd (path to project) && (command")
		expect(result).toContain("Note: Using `&&` for cmd.exe command chaining")
	})

	it("includes Unix utility guidance for PowerShell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		const result = getRulesSection(cwd)

		expect(result).toContain("IMPORTANT: When using PowerShell, avoid Unix-specific utilities")
		expect(result).toContain("`sed`, `grep`, `awk`, `cat`, `rm`, `cp`, `mv`")
		expect(result).toContain("`Select-String` for grep")
		expect(result).toContain("`Get-Content` for cat")
		expect(result).toContain("PowerShell's `-replace` operator")
	})

	it("includes Unix utility guidance for cmd.exe", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		const result = getRulesSection(cwd)

		expect(result).toContain("IMPORTANT: When using cmd.exe, avoid Unix-specific utilities")
		expect(result).toContain("`sed`, `grep`, `awk`, `cat`, `rm`, `cp`, `mv`")
		expect(result).toContain("`type` for cat")
		expect(result).toContain("`del` for rm")
		expect(result).toContain("`find`/`findstr` for grep")
	})

	it("does not include Unix utility guidance for Unix shells", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		const result = getRulesSection(cwd)

		expect(result).not.toContain("IMPORTANT: When using PowerShell")
		expect(result).not.toContain("IMPORTANT: When using cmd.exe")
		expect(result).not.toContain("`Select-String` for grep")
	})

	it("does not include note for Unix shells", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/zsh")
		const result = getRulesSection(cwd)

		expect(result).not.toContain("Note: Using")
	})
})
