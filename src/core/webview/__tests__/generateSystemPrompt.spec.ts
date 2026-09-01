// npx vitest src/core/webview/__tests__/generateSystemPrompt.spec.ts
//
// Preview parity: generateSystemPrompt (the webview preview path) must produce
// the same CAPABILITIES / RULES / SYSTEM INFORMATION sections as a direct
// SYSTEM_PROMPT call built from the *same* inputs — including a full ModelInfo,
// so model-level excludedTools/includedTools are honored in the preview exactly
// like the runtime path (plan §6.3 / §8, and fix-plan issue 8: the old
// `{ isStealthModel }`-only typing silently allowed the preview to ignore them).

vi.mock("os", () => ({
	default: {
		homedir: () => "/home/user",
		platform: () => "linux",
		arch: () => "x64",
		type: () => "Linux",
		release: () => "5.4.0",
		hostname: () => "test-host",
		tmpdir: () => "/tmp",
		endianness: () => "LE",
		loadavg: () => [0, 0, 0],
		totalmem: () => 8589934592,
		freemem: () => 4294967296,
		cpus: () => [],
		networkInterfaces: () => ({}),
		userInfo: () => ({ username: "test", uid: 1000, gid: 1000, shell: "/bin/bash", homedir: "/home/user" }),
	},
	homedir: () => "/home/user",
	platform: () => "linux",
	arch: () => "x64",
	type: () => "Linux",
	release: () => "5.4.0",
	hostname: () => "test-host",
	tmpdir: () => "/tmp",
	endianness: () => "LE",
	loadavg: () => [0, 0, 0],
	totalmem: () => 8589934592,
	freemem: () => 4294967296,
	cpus: () => [],
	networkInterfaces: () => ({}),
	userInfo: () => ({ username: "test", uid: 1000, gid: 1000, shell: "/bin/bash", homedir: "/home/user" }),
}))

vi.mock("os-name", () => ({
	default: () => "Linux",
}))

vi.mock("fs/promises")

import * as vscode from "vscode"

import type { ModelInfo } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { SYSTEM_PROMPT } from "../../prompts/system"
import { generateSystemPrompt } from "../generateSystemPrompt"
import type { ClineProvider } from "../ClineProvider"
import "../../../utils/path"

// Mock vscode — generateSystemPrompt reads env.language and workspace config.
vi.mock("vscode", () => ({
	env: {
		language: "en",
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/test/path" } }],
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue(undefined),
		}),
		getWorkspaceFolder: vi.fn().mockReturnValue({ uri: { fsPath: "/test/path" } }),
	},
	window: {
		activeTextEditor: undefined,
	},
	EventEmitter: vi.fn().mockImplementation(function () {
		return {
			event: vi.fn(),
			fire: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))

vi.mock("../../../utils/shell", () => ({
	getShell: () => "/bin/zsh",
}))

// Mock the section builders that touch the filesystem / extension context so the
// parity comparison is stable and independent of workspace state.
vi.mock("../../prompts/sections/modes", () => ({
	getModesSection: vi.fn().mockImplementation(async () => `====\n\nMODES\n\n- Test modes section`),
}))

vi.mock("../../prompts/sections/custom-instructions", () => ({
	addCustomInstructions: vi.fn().mockImplementation(async () => ""),
}))

// The preview must consume a *complete* ModelInfo from the API handler. This
// locks in the issue-8 contract: if generateSystemPrompt ever narrows the local
// modelInfo back down, the excludedTools sub-assertion below fails.
const fullModelInfo: ModelInfo = {
	contextWindow: 100_000,
	supportsPromptCache: true,
	excludedTools: ["read_file"],
}

// Note: the module under test imports `../../api` from src/core/webview, which
// resolves to src/api — from this spec's directory (one level deeper) that is
// `../../../api`.
vi.mock("../../../api", () => ({
	buildApiHandler: () => ({
		getModel: () => ({ id: "m", info: fullModelInfo }),
	}),
}))

// Minimal mock ExtensionContext, mirroring the pattern in system-prompt.spec.ts.
const mockContext = {
	extensionPath: "/mock/extension/path",
	globalStoragePath: "/mock/storage/path",
	storagePath: "/mock/storage/path",
	logPath: "/mock/log/path",
	subscriptions: [],
	workspaceState: {
		get: () => undefined,
		update: () => Promise.resolve(),
	},
	globalState: {
		get: () => undefined,
		update: () => Promise.resolve(),
		setKeysForSync: () => {},
	},
	extensionUri: { fsPath: "/mock/extension/path" },
	globalStorageUri: { fsPath: "/mock/settings/path" },
	asAbsolutePath: (relativePath: string) => `/mock/extension/path/${relativePath}`,
	extension: {
		packageJSON: {
			version: "1.0.0",
		},
	},
} as unknown as vscode.ExtensionContext

const fullSettings = {
	todoListEnabled: true,
	useAgentRules: true,
	newTaskRequireTodos: false,
}

describe("generateSystemPrompt preview parity", () => {
	// Section-scoped extraction: capture the text between two "====" headers so
	// the comparison is limited to the sections the tool policy drives.
	function extractSection(prompt: string, header: string): string {
		const marker = `\n\n${header}\n\n`
		const idx = prompt.indexOf(marker)
		expect(idx).toBeGreaterThan(-1)
		const afterHeader = prompt.slice(idx + marker.length)
		const nextMarker = afterHeader.indexOf("\n\n====")
		return nextMarker === -1 ? afterHeader : afterHeader.slice(0, nextMarker)
	}

	/**
	 * ClineProvider is a heavy class; the preview only touches these members, so
	 * a minimal object literal stands in for it. This is the single double
	 * assertion in this spec.
	 */
	const fakeProvider = {
		context: mockContext,
		cwd: "/test/path",
		getState: vi.fn().mockResolvedValue({
			apiConfiguration: { apiProvider: providerIdentifiers.openai, modelId: "gpt-4o" },
			customModePrompts: undefined,
			customInstructions: undefined,
			mcpEnabled: false,
			experiments: {},
			language: undefined,
			enableSubfolderRules: false,
			disabledTools: undefined,
		}),
		getMcpHub: vi.fn(),
		getCurrentTask: vi.fn().mockReturnValue(undefined),
		getSkillsManager: vi.fn().mockReturnValue(undefined),
		customModesManager: {
			getCustomModes: vi.fn().mockResolvedValue([]),
		},
	} as unknown as ClineProvider

	it("produces identical CAPABILITIES, RULES, and SYSTEM INFORMATION sections for the same inputs", async () => {
		const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

		// The direct SYSTEM_PROMPT call uses exactly the inputs the webview path
		// builds: same disabledTools (undefined), same full modelInfo, same
		// settings shape.
		const direct = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			"code",
			undefined, // customModePrompts
			undefined, // customModes
			undefined, // globalCustomInstructions
			{}, // experiments
			undefined, // language
			undefined, // rooIgnoreInstructions
			fullSettings, // settings
			undefined, // todoList
			undefined, // modelId
			undefined, // skillsManager
			undefined, // disabledTools
			fullModelInfo, // modelInfo
		)

		for (const header of ["CAPABILITIES", "RULES", "SYSTEM INFORMATION"]) {
			expect(extractSection(preview, header)).toEqual(extractSection(direct, header))
		}
	})

	it("honors the full modelInfo.excludedTools in the preview output", async () => {
		const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })
		const capabilities = extractSection(preview, "CAPABILITIES")

		// read_file is excluded by the model info: no "read files" clause.
		expect(capabilities).not.toContain("read files")
		// Other clauses survive, proving the exclusion is scoped to that tool.
		expect(capabilities).toContain("execute CLI commands")
	})
})
