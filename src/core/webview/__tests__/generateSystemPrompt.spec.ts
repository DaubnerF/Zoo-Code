// npx vitest src/core/webview/__tests__/generateSystemPrompt.spec.ts
//
// Preview parity: generateSystemPrompt (the webview preview path) must produce
// the same CAPABILITIES / RULES / SYSTEM INFORMATION sections as a direct
// SYSTEM_PROMPT call built from the *same* inputs — including a full ModelInfo
// and the state's disabledTools, threaded exactly like the runtime path. The
// prompt prose sections render their static upstream wording; the effective
// tool policy still flows to API tool construction and runtime validation.

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

// getShell feeds the command-chaining text in RULES; stub it so the real
// implementation never touches the environment. vi.hoisted keeps the double
// initialized before the hoisted module-factory mock evaluates it.
const shellMock = vi.hoisted(() => ({ shell: "/bin/zsh" }))

vi.mock("../../../utils/shell", () => ({
	getShell: () => shellMock.shell,
}))

// Mock the section builders that touch the filesystem / extension context so the
// parity comparison is stable and independent of workspace state.
vi.mock("../../prompts/sections/modes", () => ({
	getModesSection: vi.fn().mockImplementation(async () => `====\n\nMODES\n\n- Test modes section`),
}))

vi.mock("../../prompts/sections/custom-instructions", () => ({
	addCustomInstructions: vi.fn().mockImplementation(async () => ""),
}))

// The preview consumes a *complete* ModelInfo from the API handler. The two
// fixtures stay deliberately distinct — mirroring router providers, which
// expose fallback metadata before the network fetch resolves and full metadata
// (including excludedTools) only after — so the fetch-state double below stays
// faithful to the providers this plumbing exists for.
const fullModelInfo: ModelInfo = {
	contextWindow: 100_000,
	supportsPromptCache: true,
	excludedTools: ["read_file"],
}

const fallbackModelInfo: ModelInfo = {
	contextWindow: 32_000,
	supportsPromptCache: false,
	excludedTools: ["list_files"],
}

const modelMock = vi.hoisted(() => {
	const state = { fetched: false }
	const ensureModelFetched = vi.fn(async () => {
		state.fetched = true
	})
	return { state, ensureModelFetched }
})

// Note: the module under test imports `../../api` from src/core/webview, which
// resolves to src/api — from this spec's directory (one level deeper) that is
// `../../../api`.
vi.mock("../../../api", () => ({
	buildApiHandler: () => ({
		ensureModelFetched: modelMock.ensureModelFetched,
		// The handler only knows its full metadata (incl. excludedTools) after
		// ensureModelFetched() resolves, mirroring router providers.
		getModel: () => ({ id: "m", info: modelMock.state.fetched ? fullModelInfo : fallbackModelInfo }),
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
	// Spy lifecycle owned by the describe (mirrors Task.spec.ts's consoleErrorSpy
	// pattern): a failed assertion inside the rejection test must not leak a
	// stubbed console.error into later tests. afterEach restores only this spy;
	// the shared vi.fn() doubles (getStateMock, modelMock) are deliberately left
	// untouched so their defaults persist for the other tests in this file
	// (vi.resetAllMocks() would clobber them).
	let errorSpy: ReturnType<typeof vi.spyOn>

	// The temp handler starts every test in the lazy (pre-fetch) state so the
	// fetch-ordering assertions below genuinely exercise the await.
	beforeEach(() => {
		modelMock.state.fetched = false
		modelMock.ensureModelFetched.mockClear()
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		errorSpy.mockRestore()
	})

	// Section-scoped extraction: capture the text between two "====" headers so
	// the comparison is limited to the sections the prompt plumbing drives.
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
	// The preview only destructures a handful of getState() fields, so the mock
	// returns that subset instead of a full ExtensionState; keeping the raw
	// vi.fn() (rather than vi.mocked) avoids casting the partial doubles.
	const getStateMock = vi.fn().mockResolvedValue({
		apiConfiguration: { apiProvider: providerIdentifiers.openai, apiModelId: "gpt-4o" },
		customModePrompts: undefined,
		customInstructions: undefined,
		mcpEnabled: false,
		experiments: {},
		language: undefined,
		enableSubfolderRules: false,
		disabledTools: undefined,
	})

	const fakeProvider = {
		context: mockContext,
		cwd: "/test/path",
		getState: getStateMock,
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

	it("awaits ensureModelFetched once before building the preview", async () => {
		// A lazily loaded router model must be fetched before the preview reads
		// getModel().info, so the modelInfo handed to SYSTEM_PROMPT matches the
		// runtime path. The deferred fetch proves the wait directly: while the
		// fetch is pending, the preview promise stays unsettled.
		let resolveFetch!: () => void
		const deferredFetch = new Promise<void>((resolve) => {
			resolveFetch = resolve
		})
		modelMock.ensureModelFetched.mockImplementationOnce(() => deferredFetch)

		const previewPromise = generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

		let settled = false
		void previewPromise.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)

		// Flush one macrotask so a missing await would have settled the promise.
		await new Promise<void>((resolve) => setTimeout(resolve, 0))

		expect(modelMock.ensureModelFetched).toHaveBeenCalledTimes(1)
		expect(settled).toBe(false)

		resolveFetch()
		const preview = await previewPromise

		expect(modelMock.ensureModelFetched).toHaveBeenCalledTimes(1)
		expect(preview).toContain("====")
	})

	it("falls back to handler model info when ensureModelFetched rejects", async () => {
		// A network failure must not abort the preview: the runtime path
		// (Task.safeEnsureModelFetched) degrades to getModel().info fallback
		// metadata, and the preview must do the same instead of rejecting or
		// dropping the modelInfo argument entirely.
		modelMock.ensureModelFetched.mockRejectedValueOnce(new Error("network down"))

		const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

		// The preview still resolves to a prompt.
		expect(preview).toContain("====")
		expect(errorSpy).toHaveBeenCalled()
		// The context string is part of the contract: an empty or generic log
		// line would erase the only trace of a degraded preview.
		expect(errorSpy).toHaveBeenCalledWith(
			"Error fetching model metadata for system prompt preview:",
			expect.anything(),
		)
	})

	it("degrades to fallback metadata when ensureModelFetched hangs past the preview timeout", async () => {
		// A hung metadata endpoint (some fetchers issue unbounded GETs) must not
		// block the user-triggered preview: after PREVIEW_MODEL_FETCH_TIMEOUT_MS
		// (5s) the race resolves and the prompt is built from the handler's
		// current metadata, identical to the rejected-fetch degradation.
		vi.useFakeTimers()
		try {
			modelMock.ensureModelFetched.mockImplementationOnce(() => new Promise<void>(() => {}))

			const previewPromise = generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })
			await vi.advanceTimersByTimeAsync(5_000)
			const preview = await previewPromise

			// The preview still resolves to a prompt past the bound.
			expect(preview).toContain("====")
		} finally {
			vi.useRealTimers()
		}
	})

	it("resolves when settings are omitted instead of dereferencing them", async () => {
		// generatePrompt reads `settings?.todoListEnabled`; without the optional
		// chain this call rejects with a TypeError on the undefined settings object.
		const prompt = await SYSTEM_PROMPT(
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
			undefined, // settings -> exercises the `settings?.` optional chain
		)

		expect(prompt).toContain("OBJECTIVE")
	})

	describe("preview metadata-fetch robustness", () => {
		it("skips the metadata fetch silently when the handler has no ensureModelFetched", async () => {
			// Providers without lazy model discovery legitimately lack
			// ensureModelFetched: the optional call must skip it and still build
			// the preview from the handler's current metadata, without logging.
			// The property is redefined to undefined on the shared double (then
			// restored) because the mocked factory reads it per buildApiHandler()
			// call, so a missing method reaches the code under test untyped.
			const descriptor = Object.getOwnPropertyDescriptor(modelMock, "ensureModelFetched")
			Object.defineProperty(modelMock, "ensureModelFetched", {
				value: undefined,
				configurable: true,
				writable: true,
			})
			try {
				const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

				expect(errorSpy).not.toHaveBeenCalled()
				expect(preview).toContain("====")
			} finally {
				if (descriptor) {
					Object.defineProperty(modelMock, "ensureModelFetched", descriptor)
				}
			}
		})

		it("clears the pending preview timer once the fetch resolves first", async () => {
			vi.useFakeTimers()
			try {
				modelMock.ensureModelFetched.mockResolvedValueOnce(undefined)
				await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

				// The fetch won the race, so the still-pending timeout must have been
				// cancelled inside the same turn; a leftover timer means every fast
				// preview leaves a five-second handle behind.
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		})

		it("resolves the preview race exactly at the fetch timeout bound", async () => {
			// The race bound is an absolute wall: a hung endpoint must be released
			// precisely after 5000 ms, never a tick earlier, so a slow-but-alive
			// fetch still wins at 4999 ms.
			vi.useFakeTimers()
			try {
				modelMock.ensureModelFetched.mockImplementationOnce(() => new Promise<void>(() => {}))

				let settled = false
				const previewPromise = generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" }).then(
					(prompt) => {
						settled = true
						return prompt
					},
				)
				await vi.advanceTimersByTimeAsync(4_999)
				expect(settled).toBe(false)

				await vi.advanceTimersByTimeAsync(1)
				await previewPromise

				// Degradation at the bound is not a failure: no error is logged.
				expect(errorSpy).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		it("aborts the handler signal when the preview fetch times out", async () => {
			// The preview's bound must detach the handler-side waiter, mirroring
			// the runtime path: a signal-observing handler stops serving the
			// abandoned fetch once the bound expires.
			let capturedSignal: AbortSignal | undefined
			modelMock.ensureModelFetched.mockImplementationOnce((signal?: AbortSignal) => {
				capturedSignal = signal
				return new Promise<void>(() => {})
			})
			// Both abort sites are pinned by count: the timeout callback fires
			// exactly when the bound elapses — detaching a hung waiter before
			// the prompt is even built — and the finally block re-aborts on
			// completion. Deleting either call leaves the other as the sole,
			// strictly-too-late detach, and the count drops to one.
			const abortSpy = vi.spyOn(AbortController.prototype, "abort")

			vi.useFakeTimers()
			try {
				const previewPromise = generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })
				await vi.advanceTimersByTimeAsync(5_000)
				// Both abort sites have fired by the time the preview resolves:
				// the finally block runs before generateSystemPrompt returns, so
				// the count is asserted while the spy still holds its history
				// (mockRestore would clear it).
				await previewPromise
				expect(abortSpy).toHaveBeenCalledTimes(2)
			} finally {
				vi.useRealTimers()
				abortSpy.mockRestore()
			}
			expect(capturedSignal?.aborted).toBe(true)
		})

		it("aborts the handler signal after a fast fetch so the waiter detaches on completion", async () => {
			// The finally-block detach also covers the fetch-wins path: a
			// signal-observing handler must not keep serving waiters for a
			// preview that already finished. Without the finally abort, the
			// captured signal is never aborted on this path (no timer fires).
			let capturedSignal: AbortSignal | undefined
			modelMock.ensureModelFetched.mockImplementationOnce((signal?: AbortSignal) => {
				capturedSignal = signal
				return Promise.resolve()
			})

			await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

			expect(capturedSignal?.aborted).toBe(true)
		})

		it("logs and degrades when the model info cannot be read", async () => {
			// A throw while reading the model info escapes the fetch race and lands
			// in the outer handler: the preview must still resolve and log the
			// outer-catch context string. The state double is swapped for a
			// throwing getter because the mocked factory reads it inside
			// getModel().info, which is the read the preview performs.
			const stateDescriptor = Object.getOwnPropertyDescriptor(modelMock, "state")
			Object.defineProperty(modelMock, "state", {
				value: {
					get fetched(): never {
						throw new Error("model info unavailable")
					},
				},
				configurable: true,
				writable: true,
			})
			try {
				const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

				expect(errorSpy).toHaveBeenCalledWith(
					"Error reading model info for system prompt preview:",
					expect.anything(),
				)
				// The preview still resolves to a prompt without model guidance.
				expect(preview).toContain("====")
			} finally {
				if (stateDescriptor) {
					Object.defineProperty(modelMock, "state", stateDescriptor)
				}
			}
		})
	})
})
