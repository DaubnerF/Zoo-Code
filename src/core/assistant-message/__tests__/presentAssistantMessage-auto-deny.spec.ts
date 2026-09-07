// npx vitest run core/assistant-message/__tests__/presentAssistantMessage-auto-deny.spec.ts

import type { Anthropic } from "@anthropic-ai/sdk"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { validateToolUse } from "../../tools/validateToolUse"
import type { Task } from "../../task/Task"

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../tools/validateToolUse")>()
	return {
		...actual,
		validateToolUse: vi.fn(),
	}
})

vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		has: vi.fn(() => false),
		get: vi.fn(),
	},
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureException: vi.fn(),
			captureEvent: vi.fn(),
		},
	},
}))

// Mock the tool handlers so each test controls exactly what askApproval/pushToolResult
// callbacks do inside a tool execution, isolating the approval-flow behavior of
// presentAssistantMessage itself.
const { executeCommandHandle, listFilesHandle, useMcpToolHandle } = vi.hoisted(() => ({
	executeCommandHandle: vi.fn(),
	listFilesHandle: vi.fn(),
	useMcpToolHandle: vi.fn(),
}))

vi.mock("../../tools/ExecuteCommandTool", () => ({
	executeCommandTool: { handle: executeCommandHandle },
}))

vi.mock("../../tools/ListFilesTool", () => ({
	listFilesTool: { handle: listFilesHandle },
}))

vi.mock("../../tools/UseMcpToolTool", () => ({
	useMcpToolTool: { handle: useMcpToolHandle },
}))

interface MockTask {
	taskId: string
	instanceId: string
	abort: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	currentStreamingContentIndex: number
	assistantMessageContent: unknown[]
	userMessageContent: Anthropic.ToolResultBlockParam[]
	didCompleteReadingStream: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	consecutiveMistakeCount: number
	clineMessages: unknown[]
	api: { getModel: () => { id: string; info: Record<string, unknown> } }
	apiConfiguration: { apiProvider: string }
	recordToolUsage: ReturnType<typeof vi.fn>
	recordToolError: ReturnType<typeof vi.fn>
	toolRepetitionDetector: { check: ReturnType<typeof vi.fn> }
	providerRef: {
		deref: () => {
			getState: ReturnType<typeof vi.fn>
			getMcpHub?: () => { findServerNameBySanitizedName: (name: string) => string | undefined }
		}
	}
	say: ReturnType<typeof vi.fn>
	ask: ReturnType<typeof vi.fn>
	pushToolResultToUserContent: ReturnType<typeof vi.fn>
}

function buildMockTask(): MockTask {
	const mockTask: MockTask = {
		taskId: "test-task-id",
		instanceId: "test-instance",
		abort: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		assistantMessageContent: [],
		userMessageContent: [],
		didCompleteReadingStream: true,
		didRejectTool: false,
		didAlreadyUseTool: false,
		consecutiveMistakeCount: 0,
		clineMessages: [],
		api: {
			getModel: () => ({ id: "test-model", info: {} }),
		},
		apiConfiguration: { apiProvider: "test" },
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		toolRepetitionDetector: {
			check: vi.fn().mockReturnValue({ allowExecution: true }),
		},
		providerRef: {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({
					mode: "code",
					customModes: [],
				}),
			}),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		pushToolResultToUserContent: vi.fn(),
	}

	// Mirror the real Task: collect tool results into userMessageContent, one per
	// tool_use_id, so assertions can inspect the exact payloads the model receives.
	mockTask.pushToolResultToUserContent = vi.fn().mockImplementation((toolResult: Anthropic.ToolResultBlockParam) => {
		const existingResult = mockTask.userMessageContent.find(
			(block) => block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
		)
		if (existingResult) {
			return false
		}
		mockTask.userMessageContent.push(toolResult)
		return true
	})

	return mockTask
}

const executeCommandBlock = {
	type: "tool_use",
	id: "call_exec",
	name: "execute_command",
	params: { command: "rm x && npm test" },
	nativeArgs: { command: "rm x && npm test" },
	partial: false,
}

const listFilesBlock = {
	type: "tool_use",
	id: "call_ls",
	name: "list_files",
	params: { path: "src" },
	nativeArgs: { path: "src" },
	partial: false,
}

const NOT_ALLOWLISTED_DETAIL = {
	kind: "not_allowlisted" as const,
	command: "rm x && npm test",
}

describe("presentAssistantMessage - automatic (policy) denials", () => {
	let mockTask: MockTask

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(validateToolUse).mockImplementation(() => undefined)
		mockTask = buildMockTask()

		// The mocked execute_command handler only runs the approval step: an
		// automatic denial means the tool returns without executing anything.
		executeCommandHandle.mockImplementation(
			async (
				_task: unknown,
				_block: unknown,
				{ askApproval }: { askApproval: (t: string, m?: string) => Promise<boolean> },
			) => {
				await askApproval("command", "rm x && npm test")
			},
		)

		// The mocked list_files handler records whether it ever ran, and pushes a
		// recognizable result when its own approval succeeds.
		listFilesHandle.mockImplementation(
			async (
				_task: unknown,
				_block: unknown,
				{
					askApproval,
					pushToolResult,
				}: { askApproval: (t: string, m?: string) => Promise<boolean>; pushToolResult: (c: string) => void },
			) => {
				const approved = await askApproval("tool", JSON.stringify({ tool: "listFilesTopLevel", path: "src" }))
				if (approved) {
					pushToolResult("second tool executed")
				}
			},
		)
	})

	it("pushes a structured auto_deny tool_result, keeps didRejectTool false, and lets the next tool execute", async () => {
		mockTask.assistantMessageContent = [executeCommandBlock, listFilesBlock]

		// First ask: automatic denial with structured detail. Second ask: approval.
		mockTask.ask
			.mockResolvedValueOnce({ response: "noButtonClicked", autoDenyDetail: NOT_ALLOWLISTED_DETAIL })
			.mockResolvedValueOnce({ response: "yesButtonClicked" })

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockTask.userMessageContent).toHaveLength(2)

		// The denied command gets the structured auto_deny payload naming the reason.
		const denialResult = mockTask.userMessageContent[0]
		expect(denialResult.type).toBe("tool_result")
		expect(denialResult.tool_use_id).toBe("call_exec")
		const denialPayload = JSON.parse(denialResult.content as string)
		expect(denialPayload.status).toBe("denied")
		expect(denialPayload.type).toBe("auto_deny")
		expect(denialPayload.reason).toContain("not on the command allowlist")
		expect(denialPayload.offending_command).toBe("rm x && npm test")

		// An automatic denial is scoped to its own tool call: it must NOT abort the
		// turn the way a user rejection does.
		expect(mockTask.didRejectTool).toBe(false)
		expect(mockTask.didAlreadyUseTool).toBe(false)

		// The reason is system-generated: it must not surface as user feedback.
		expect(mockTask.say).not.toHaveBeenCalledWith("user_feedback", expect.anything(), expect.anything())
		expect(mockTask.say).not.toHaveBeenCalledWith("user_feedback", expect.anything())

		// The second tool in the same turn still executes normally.
		expect(listFilesHandle).toHaveBeenCalledTimes(1)
		const secondResult = mockTask.userMessageContent[1]
		expect(secondResult.tool_use_id).toBe("call_ls")
		expect(secondResult.content).toBe("second tool executed")
		expect(secondResult.is_error).toBeUndefined()
	})

	it("routes an auto-deny through the MCP askApproval copy without aborting the turn", async () => {
		mockTask.assistantMessageContent = [
			{
				type: "mcp_tool_use",
				id: "call_mcp",
				name: "mcp_my_server_do_thing",
				serverName: "my_server",
				toolName: "do_thing",
				arguments: {},
				partial: false,
			},
		]

		mockTask.providerRef = {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }),
				getMcpHub: () => ({ findServerNameBySanitizedName: () => undefined }),
			}),
		}

		useMcpToolHandle.mockImplementation(
			async (
				_task: unknown,
				_block: unknown,
				{ askApproval }: { askApproval: (t: string, m?: string) => Promise<boolean> },
			) => {
				await askApproval("use_mcp_server", "{}")
			},
		)

		mockTask.ask.mockResolvedValueOnce({
			response: "noButtonClicked",
			autoDenyDetail: { kind: "denylist", command: "rm x", pattern: "rm" },
		})

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockTask.userMessageContent).toHaveLength(1)
		const payload = JSON.parse(mockTask.userMessageContent[0].content as string)
		expect(payload.type).toBe("auto_deny")
		expect(payload.reason).toContain("matches denied prefix `rm`")
		expect(payload.offending_command).toBe("rm x")
		expect(mockTask.didRejectTool).toBe(false)
		expect(mockTask.say).not.toHaveBeenCalledWith("user_feedback", expect.anything(), expect.anything())
	})

	it("keeps the legacy user-rejection behavior when the rejection carries no autoDenyDetail", async () => {
		mockTask.assistantMessageContent = [executeCommandBlock, listFilesBlock]

		// Real user click: noButtonClicked with no structured detail.
		mockTask.ask.mockResolvedValueOnce({ response: "noButtonClicked" })

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockTask.userMessageContent).toHaveLength(2)

		// Rejection wording stays the user-denial payload.
		const denialResult = mockTask.userMessageContent[0]
		expect(denialResult.tool_use_id).toBe("call_exec")
		const denialPayload = JSON.parse(denialResult.content as string)
		expect(denialPayload.message).toBe("The user denied this operation.")
		expect(denialPayload.type).toBeUndefined()

		// A real user rejection still aborts the rest of the turn.
		expect(mockTask.didRejectTool).toBe(true)

		// The remaining tool is skipped with the "user rejecting a previous tool"
		// message and never executes.
		expect(listFilesHandle).not.toHaveBeenCalled()
		const skippedResult = mockTask.userMessageContent[1]
		expect(skippedResult.tool_use_id).toBe("call_ls")
		expect(skippedResult.is_error).toBe(true)
		expect(skippedResult.content).toContain("due to user rejecting a previous tool")
		expect(skippedResult.content).not.toContain("auto_deny")
	})

	it("persists user feedback as a user_feedback say row on a text-carrying rejection (no detail)", async () => {
		mockTask.assistantMessageContent = [executeCommandBlock]

		mockTask.ask.mockResolvedValueOnce({ response: "noButtonClicked", text: "do not run that" })

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "do not run that", undefined)
		expect(mockTask.didRejectTool).toBe(true)

		const payload = JSON.parse(mockTask.userMessageContent[0].content as string)
		expect(payload.status).toBe("denied")
		expect(payload.feedback).toBe("do not run that")
		expect(payload.type).toBeUndefined()
	})
})
