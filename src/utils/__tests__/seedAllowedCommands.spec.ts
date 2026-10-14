// npx vitest run utils/__tests__/seedAllowedCommands.spec.ts

import * as vscode from "vscode"

import { makeWorkspaceConfiguration } from "../../test-utils/vscode"
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
	const config = makeWorkspaceConfiguration()
	// The shared double is scripted after creation so the per-test fixture
	// values need no type assertion at the construction site.
	vi.mocked(config.get).mockReturnValue(effective)
	vi.mocked(config.inspect).mockImplementation(() => {
		if (inspectThrows) {
			throw new Error("configuration access failed")
		}
		return inspect
	})
	vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(config)
}

function mockMemento(existing: unknown = undefined) {
	const store = new Map<string, unknown>()
	if (existing !== undefined) {
		store.set("allowedCommands", existing)
	}

	// Structurally complete Memento double (keys/get/update), so the call
	// sites need no type assertion.
	return {
		keys: vi.fn((): readonly string[] => [...store.keys()]),
		get: vi.fn().mockImplementation((key: string) => store.get(key)),
		update: vi.fn().mockImplementation(async (key: string, value: unknown) => {
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

		await seedAllowedCommands(globalState)

		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("allowedCommands")).toBeUndefined()
	})

	it("seeds from the global-scope value when global state is empty", async () => {
		mockConfiguration({ inspect: { key: "allowedCommands", globalValue: ["git"] }, effective: ["git"] })
		const globalState = mockMemento()

		await seedAllowedCommands(globalState)

		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("allowedCommands", ["git"])
		expect(globalState.get("allowedCommands")).toEqual(["git"])
	})

	it("does not overwrite global state that is already populated", async () => {
		mockConfiguration({ inspect: { key: "allowedCommands", globalValue: ["git"] }, effective: ["git"] })
		const globalState = mockMemento(["npm"])

		await seedAllowedCommands(globalState)

		expect(globalState.update).not.toHaveBeenCalled()
		expect(globalState.get("allowedCommands")).toEqual(["npm"])
	})

	it("inspects the global value under the extension's own section key", async () => {
		// The seed must read the extension's own section; asking VS Code about
		// a different (or empty) section key would silently never find the
		// user's global list.
		mockConfiguration({ inspect: { key: "allowedCommands", globalValue: ["git"] } })
		// Structurally complete Memento double (keys/get/update), so the call
		// site needs no type assertion.
		const globalState: vscode.Memento = {
			keys: () => [],
			get: vi.fn(),
			update: vi.fn(),
		}

		await seedAllowedCommands(globalState)

		const config = vi.mocked(vscode.workspace.getConfiguration).mock.results[0].value
		expect(config.inspect).toHaveBeenCalledWith("allowedCommands")
		expect(globalState.update).toHaveBeenCalledExactlyOnceWith("allowedCommands", ["git"])
	})

	it("leaves global state untouched when there is no inspect result at all", async () => {
		mockConfiguration({ inspect: undefined, effective: ["git"] })
		const globalState = mockMemento()

		await seedAllowedCommands(globalState)

		expect(globalState.update).not.toHaveBeenCalled()
	})

	it("skips the seed without throwing when configuration access fails", async () => {
		mockConfiguration({ inspectThrows: true })
		const globalState = mockMemento()

		await expect(seedAllowedCommands(globalState)).resolves.toBeUndefined()

		expect(globalState.update).not.toHaveBeenCalled()
	})

	it("does not share a reference with the inspected configuration value", async () => {
		const globalValue = ["git"]
		mockConfiguration({ inspect: { key: "allowedCommands", globalValue } })
		const globalState = mockMemento()

		await seedAllowedCommands(globalState)

		expect(globalState.update).toHaveBeenCalledWith("allowedCommands", expect.arrayContaining(["git"]))
		expect(globalState.update.mock.calls[0][1]).not.toBe(globalValue)
	})
})
