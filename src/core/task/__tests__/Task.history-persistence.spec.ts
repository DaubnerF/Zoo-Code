// cd src && npx vitest run core/task/__tests__/Task.history-persistence.spec.ts

import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import type { GlobalState, ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

type TaskHistoryPersistenceAccess = {
	saveApiConversationHistory: (merge?: boolean) => Promise<boolean>
	overwriteApiConversationHistory: (messages: unknown[], persist?: boolean) => Promise<void>
	flushPendingToolResultsToHistory: () => Promise<boolean>
	assistantMessageSavedToHistory: boolean
	userMessageContent: unknown[]
}

function getTaskHistoryPersistenceAccess(task: Task): TaskHistoryPersistenceAccess {
	return task as unknown as TaskHistoryPersistenceAccess
}

function createDeferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

async function drainMicrotasks() {
	for (let i = 0; i < 10; i++) {
		await new Promise((resolve) => setImmediate(resolve))
	}
}

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const {
	mockSaveApiMessages,
	mockSaveTaskMessages,
	mockReadApiMessages,
	mockReadTaskMessages,
	mockTaskMetadata,
	mockPWaitFor,
} = vi.hoisted(() => ({
	mockSaveApiMessages: vi.fn().mockResolvedValue(undefined),
	mockSaveTaskMessages: vi.fn().mockResolvedValue(undefined),
	mockReadApiMessages: vi.fn().mockResolvedValue([]),
	mockReadTaskMessages: vi.fn().mockResolvedValue([]),
	mockTaskMetadata: vi.fn().mockResolvedValue({
		historyItem: { id: "test-id", ts: Date.now(), task: "test" },
		tokenUsage: {
			totalTokensIn: 0,
			totalTokensOut: 0,
			totalCacheWrites: 0,
			totalCacheReads: 0,
			totalCost: 0,
			contextTokens: 0,
		},
	}),
	mockPWaitFor: vi.fn().mockResolvedValue(undefined),
}))

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("p-wait-for", () => ({
	default: mockPWaitFor,
}))

vi.mock("../../task-persistence", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../task-persistence")>()
	return {
		...mod,
		saveApiMessages: mockSaveApiMessages,
		saveTaskMessages: mockSaveTaskMessages,
		readApiMessages: mockReadApiMessages,
		readTaskMessages: mockReadTaskMessages,
		taskMetadata: mockTaskMetadata,
		TaskHistoryStore: vi.fn().mockImplementation(function () {
			return {
				initialize: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
				get: vi.fn(),
				getAll: vi.fn().mockReturnValue([]),
				upsert: vi.fn().mockResolvedValue([]),
				delete: vi.fn().mockResolvedValue(undefined),
				deleteMany: vi.fn().mockResolvedValue(undefined),
				reconcile: vi.fn().mockResolvedValue(undefined),
				initialized: Promise.resolve(),
			}
		}),
	}
})

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }),
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue: unknown) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(function () {
			return mockEventEmitter
		}),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
		return Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] })
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockReturnValue(false),
}))

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("Task history persistence ordering contract", () => {
	let mockProvider: ClineProvider
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: vscode.OutputChannel
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
				store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		)

		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.updateTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.log = vi.fn()
	})

	function createTask(): Task {
		return new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "history persistence test task",
			startTask: false,
		})
	}

	describe("completion-time save is durably awaited", () => {
		it("does not resolve the save before the durable write settles", async () => {
			const task = createTask()
			const access = getTaskHistoryPersistenceAccess(task)
			const deferred = createDeferred<undefined>()
			mockSaveApiMessages.mockImplementationOnce(() => deferred.promise)

			task.apiConversationHistory.push({
				role: "user",
				content: [{ type: "text", text: "pending write" }],
			})

			let settled = false
			const savePromise = access.saveApiConversationHistory().then((result) => {
				settled = true
				return result
			})

			await drainMicrotasks()
			expect(settled).toBe(false)

			deferred.resolve(undefined)
			await expect(savePromise).resolves.toBe(true)
			expect(settled).toBe(true)
		})

		it("passes a snapshot with merge semantics on incremental saves", async () => {
			const task = createTask()
			const access = getTaskHistoryPersistenceAccess(task)

			task.apiConversationHistory.push({
				role: "user",
				content: [{ type: "text", text: "snapshot" }],
			})

			await expect(access.saveApiConversationHistory()).resolves.toBe(true)

			expect(mockSaveApiMessages).toHaveBeenCalledTimes(1)
			const args = mockSaveApiMessages.mock.calls[0][0]
			expect(args.merge).toBe(true)
			expect(args.messages).not.toBe(task.apiConversationHistory)
			expect(args.messages).toEqual(task.apiConversationHistory)
		})
	})

	describe("authoritative overwrite vs hydration", () => {
		it("persists explicit overwrites as authoritative (merge: false)", async () => {
			const task = createTask()
			const access = getTaskHistoryPersistenceAccess(task)

			await access.overwriteApiConversationHistory([{ role: "user", content: "authoritative" }])

			expect(mockSaveApiMessages).toHaveBeenCalledTimes(1)
			expect(mockSaveApiMessages).toHaveBeenCalledWith(expect.objectContaining({ merge: false }))
		})

		it("hydrates without touching the persisted file when persist is false", async () => {
			const task = createTask()
			const access = getTaskHistoryPersistenceAccess(task)

			await access.overwriteApiConversationHistory([{ role: "user", content: "hydrated only" }], false)

			expect(mockSaveApiMessages).not.toHaveBeenCalled()
			expect(task.apiConversationHistory).toEqual([
				expect.objectContaining({ role: "user", content: "hydrated only", messageId: expect.any(String) }),
			])
		})
	})

	describe("flushPendingToolResultsToHistory only clears pending content after a durable save", () => {
		it("returns true and clears pending content when the save settles", async () => {
			const task = createTask()
			const access = getTaskHistoryPersistenceAccess(task)
			access.assistantMessageSavedToHistory = true
			access.userMessageContent = [
				{ type: "tool_result", tool_use_id: "toolu_1", content: "done", is_error: false },
			]

			await expect(access.flushPendingToolResultsToHistory()).resolves.toBe(true)

			expect(access.userMessageContent).toEqual([])
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(1)
			expect(task.apiConversationHistory).toHaveLength(1)
		})

		it("returns false and retains pending content when the save fails", async () => {
			const task = createTask()
			const access = getTaskHistoryPersistenceAccess(task)
			access.assistantMessageSavedToHistory = true
			const pending = [{ type: "tool_result", tool_use_id: "toolu_1", content: "done", is_error: false }]
			access.userMessageContent = pending

			mockSaveApiMessages.mockRejectedValueOnce(new Error("disk unavailable"))

			await expect(access.flushPendingToolResultsToHistory()).resolves.toBe(false)

			expect(access.userMessageContent).toEqual(pending)
		})
	})

	// Guards the discriminating power of the "does not resolve the save before the
	// durable write settles" pin above: a fire-and-forget seam (the regression this
	// pin exists to catch) resolves the save before the write settles, so the pin's
	// invariant would flip to false under that mutation.
	describe("mutation guard: the pending-until-durable pin discriminates fire-and-forget", () => {
		it("a fire-and-forget save wrapper resolves before the durable write settles", async () => {
			const deferred = createDeferred<void>()
			const fireAndForgetSave = () => {
				void deferred.promise
				return Promise.resolve(true)
			}

			let settled = false
			await fireAndForgetSave().then(() => {
				settled = true
			})

			expect(settled).toBe(true)

			const awaitedSave = async () => {
				await deferred.promise
				return true
			}
			let awaitedSettled = false
			const awaitedPromise = awaitedSave().then(() => {
				awaitedSettled = true
			})
			await drainMicrotasks()
			expect(awaitedSettled).toBe(false)
			deferred.resolve()
			await awaitedPromise
		})
	})
})
