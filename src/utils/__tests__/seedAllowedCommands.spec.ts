// npx vitest run utils/__tests__/seedAllowedCommands.spec.ts

import * as vscode from "vscode"

import { seedAllowedCommands } from "../seedAllowedCommands"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
	},
}))

interface ConfigDouble {
	inspect?: {
		key: string
		defaultValue?: string[]
		globalValue?: string[]
		workspaceValue?: string[]
		workspaceFolderValue?: string[]
	}
	effective?: string[]
	inspectThrows?: boolean
}

function mockConfiguration({ inspect, effective = [], inspectThrows = false }: ConfigDouble = {}) {
	vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
		get: vi.fn().mockReturnValue(effective),
		inspect: vi.fn().mockImplementation(() => {
			if (inspectThrows) {
				throw new Error("configuration access failed")
			}
			return inspect
		}),
		update: vi.fn(),
	} as unknown as vscode.WorkspaceConfiguration)
}

function mockMemento(existing: unknown = undefined) {
	const store = new Map<string, unknown>()
	if (existing !== undefined) {
		store.set("allowedCommands", existing)
	}

	return {
		get: vi.fn((key: string) => store.get(key)),
		update: vi.fn(async (key: string, value: unknown) => {
			store.set(key, value)
		}),
	}
}

describe("seedAllowedCommands", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("leaves global state unset when only a workspace-scoped value exists", async () => {
		// A real VS Code get() folds the workspace override into the effective
		// value, so this is the leak scenario: reading get() would seed
		// ["docker"] (from .vscode/settings.json) into global state.
		mockConfiguration({
			inspect: { key: "allowedCommands", globalValue: undefined, workspaceValue: ["docker"] },
			effective: ["docker"],
		})
		const globalState = mockMemento()

		await seedAllowedCommands(globalState as unknown as vscode.Memento)

		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("allowedCommands")).toBeUndefined()
	})

	it("seeds from the global-scope value when global state is empty", async () => {
		mockConfiguration({ inspect: { key: "allowedCommands", globalValue: ["git"] }, effective: ["git"] })
		const globalState = mockMemento()

		await seedAllowedCommands(globalState as unknown as vscode.Memento)

		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("allowedCommands", ["git"])
		expect(globalState.get("allowedCommands")).toEqual(["git"])
	})

	it("does not overwrite global state that is already populated", async () => {
		mockConfiguration({ inspect: { key: "allowedCommands", globalValue: ["git"] }, effective: ["git"] })
		const globalState = mockMemento(["npm"])

		await seedAllowedCommands(globalState as unknown as vscode.Memento)

		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("allowedCommands")).toEqual(["npm"])
	})

	it("leaves global state untouched when there is no inspect result at all", async () => {
		mockConfiguration({ inspect: undefined, effective: ["git"] })
		const globalState = mockMemento()

		await seedAllowedCommands(globalState as unknown as vscode.Memento)

		expect(globalState.update).not.toHaveBeenCalled()
	})

	it("skips the seed without throwing when configuration access fails", async () => {
		mockConfiguration({ inspectThrows: true })
		const globalState = mockMemento()

		await expect(seedAllowedCommands(globalState as unknown as vscode.Memento)).resolves.toBeUndefined()

		expect(globalState.update).not.toHaveBeenCalled()
	})

	it("does not share a reference with the inspected configuration value", async () => {
		const globalValue = ["git"]
		mockConfiguration({ inspect: { key: "allowedCommands", globalValue } })
		const globalState = mockMemento()

		await seedAllowedCommands(globalState as unknown as vscode.Memento)

		expect(globalState.update).toHaveBeenCalledWith("allowedCommands", expect.arrayContaining(["git"]))
		expect(globalState.update.mock.calls[0][1]).not.toBe(globalValue)
	})
})
