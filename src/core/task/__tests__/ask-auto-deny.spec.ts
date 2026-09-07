// npx vitest run core/task/__tests__/ask-auto-deny.spec.ts

import type { ExtensionState } from "@roo-code/types"

import { Task } from "../Task"

// Blanket auto-deny (`alwaysDenyUnapprovedCommands`) at the Task level: a
// command ask that policy denies must resolve immediately with the structured
// `autoDenyDetail` (so presentAssistantMessage can distinguish it from a user
// rejection), and the chat row must carry the auto-deny chip
// (`autoApprovalDecision: "deny"` + `isAnswered`). A subsequent ask must never
// see a stale detail from a previous denial.

/** The parts of the provider that `Task.ask` reaches for. */
type ProviderStub = {
	getState: () => Promise<Partial<ExtensionState>>
	postMessageToWebview: ReturnType<typeof vi.fn>
	cwd: string
}

function buildTask(provider: ProviderStub, taskCwd: string) {
	const task = Object.create(Task.prototype) as Task
	task["abort"] = false
	task["clineMessages"] = []
	task["askResponse"] = undefined
	task["askResponseText"] = undefined
	task["askResponseImages"] = undefined
	task["lastMessageTs"] = undefined
	task["addToClineMessages"] = vi.fn(async () => {})
	task["saveClineMessages"] = vi.fn(async () => true)
	task["updateClineMessage"] = vi.fn(async () => {})
	task["cancelAutoApprovalTimeout"] = vi.fn(() => {})
	task["checkpointSave"] = vi.fn(async () => {})
	task["emit"] = vi.fn()
	// A double assertion is unavoidable here: `providerRef` is a `WeakRef<ClineProvider>`,
	// and the stub is neither a `WeakRef` nor a whole `ClineProvider`. Constructing
	// either would drag in the extension host, when `Task.ask` only ever calls
	// `deref()`, `getState()` and `postMessageToWebview()` on it.
	task["providerRef"] = { deref: () => provider } as unknown as Task["providerRef"]
	Object.defineProperty(task, "workspacePath", { value: taskCwd })

	return task
}

async function attachQueue(task: Task) {
	const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
	const queue = new MessageQueueService()
	Object.defineProperty(task, "messageQueueService", { value: queue })
	return queue
}

const TASK_CWD = "/path/to/task-workspace"

describe("Task.ask resolves blanket command denials with structured detail", () => {
	// Mutable state so a test can flip the policy between consecutive asks on
	// the same task (mirrors the live per-ask `provider.getState()` read).
	let state: Partial<ExtensionState>
	let provider: ProviderStub

	beforeEach(() => {
		state = {
			autoApprovalEnabled: true,
			alwaysAllowExecute: true,
			alwaysDenyUnapprovedCommands: true,
			allowedCommands: [],
			deniedCommands: [],
			destructiveCommandGuardEnabled: false,
		}
		provider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			cwd: TASK_CWD,
			getState: async () => state,
		}
	})

	it("auto-denies an unallowlisted command and stamps the deny chip on the chat row", async () => {
		const task = buildTask(provider, TASK_CWD)
		await attachQueue(task)

		const result = await task.ask("command", "rm x", false)

		// Policy denial: resolves without user interaction, carrying the reason.
		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail).toBeDefined()
		expect(result.autoDenyDetail?.kind).toBe("not_allowlisted")
		expect(result.autoDenyDetail?.command).toBe("rm x")

		// Chat row: the existing auto-deny chip (answered + deny decision), so no
		// approval buttons ever appear.
		const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>
		expect(addToClineMessages).toHaveBeenCalledTimes(1)
		const message = addToClineMessages.mock.calls[0][0]
		expect(message.type).toBe("ask")
		expect(message.ask).toBe("command")
		expect(message.isAnswered).toBe(true)
		expect(message.autoApprovalDecision).toBe("deny")
	})

	it("a following approved ask does not leak the previous denial's detail", async () => {
		const task = buildTask(provider, TASK_CWD)
		await attachQueue(task)

		const denied = await task.ask("command", "rm x", false)
		expect(denied.autoDenyDetail?.kind).toBe("not_allowlisted")

		// Approve the next command via the allowlist: the denial detail from the
		// previous ask must not ride along into this result.
		state.allowedCommands = ["git"]
		const approved = await task.ask("command", "git status", false)

		expect(approved.response).toBe("yesButtonClicked")
		expect(approved.autoDenyDetail).toBeUndefined()

		const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>
		expect(addToClineMessages).toHaveBeenCalledTimes(2)
		expect(addToClineMessages.mock.calls[1][0].autoApprovalDecision).toBe("approve")
	})

	it("carries a denylist denial's detail even with the blanket setting off", async () => {
		// Denylist denials were never user rejections: they carry structured
		// detail regardless of the blanket flag (unified vocabulary).
		state.alwaysDenyUnapprovedCommands = false
		state.deniedCommands = ["rm"]

		const task = buildTask(provider, TASK_CWD)
		await attachQueue(task)

		const result = await task.ask("command", "rm -rf build", false)

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail?.kind).toBe("denylist")
		expect(result.autoDenyDetail?.command).toBe("rm -rf build")
		expect(result.autoDenyDetail?.pattern).toBe("rm")

		const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>
		expect(addToClineMessages.mock.calls[0][0].autoApprovalDecision).toBe("deny")
	})
})

describe("Task.ask queue path cannot bypass blanket deny", () => {
	let state: Partial<ExtensionState>
	let provider: ProviderStub

	beforeEach(() => {
		state = {
			autoApprovalEnabled: true,
			alwaysAllowExecute: true,
			alwaysDenyUnapprovedCommands: true,
			allowedCommands: [],
			deniedCommands: [],
			destructiveCommandGuardEnabled: false,
		}
		provider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			cwd: TASK_CWD,
			getState: async () => state,
		}
	})

	it("denies a blanket-denied command ask even when a queued message would auto-approve it", async () => {
		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		// A queued message previously answered command asks with an unconditional
		// yesButtonClicked — the one sequence that bypassed blanket deny. The
		// policy denial must win, and it must carry the same structured detail
		// as the main path.
		queue.addMessage("queued feedback arriving while blanket deny is engaged")

		const result = await task.ask("command", "rm x", false)

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail).toBeDefined()
		expect(result.autoDenyDetail?.kind).toBe("not_allowlisted")
		expect(result.autoDenyDetail?.command).toBe("rm x")
		// The queued message was not consumed as a fake approval: it stays in the
		// queue for a later conversational turn.
		expect(result.queuedMessageId).toBeUndefined()
		expect(queue.messages).toHaveLength(1)
	})

	it("still lets a queued message answer a command ask when blanket deny is off", async () => {
		// Behavior unchanged while the blanket configuration is disengaged: the
		// queued-message auto-approval shortcut keeps working.
		state.alwaysDenyUnapprovedCommands = false

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		queue.addMessage("queued feedback with blanket deny off")

		const result = await task.ask("command", "rm x", false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
		// Non-durable resolution consumed the queued message.
		expect(queue.messages).toHaveLength(0)
	})
})
