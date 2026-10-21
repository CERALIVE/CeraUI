// @vitest-environment jsdom
import type {
	UpdateCapabilities,
	UpdateOrchestratorPhase,
} from "@ceraui/rpc/schemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	answer,
	CAPABLE,
	connectDevice,
	deviceDetails,
	disconnectDevice,
	FakeWebSocket,
	flush,
	outstanding,
	SETTINGS,
	sentCount,
} from "../../tests/helpers/update-device";
import { destroyAsyncOperations } from "../rpc/async-operation.svelte";
import { createUpdateSurface } from "./update-surface.svelte";

let pushedPhase: UpdateOrchestratorPhase | undefined;
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getUpdateOrchestratorState: () =>
		pushedPhase === undefined ? undefined : { phase: pushedPhase },
}));

beforeEach(() => {
	pushedPhase = undefined;
	connectDevice();
});
afterEach(() => {
	destroyAsyncOperations();
	disconnectDevice();
});

async function surfaceAt(
	phase: UpdateOrchestratorPhase | undefined,
	capabilities: UpdateCapabilities = CAPABLE,
) {
	pushedPhase = phase;
	const surface = createUpdateSurface();
	const load = surface.load();
	answer("system.getUpdateCapabilities", capabilities);
	answer("system.getUpdateSettings", SETTINGS);
	answer("system.getUpdateDetails", deviceDetails());
	await load;
	const observe = surface.observePhase(phase);
	answer("system.getUpdateDetails", deviceDetails());
	await observe;
	return surface;
}

it("a reopened dialog selects the current push rather than its last observed open phase", async () => {
	// Given an earlier package phase, then an OS offer pushed while the dialog was closed.
	const surface = await surfaceAt("available");
	surface.reset();
	pushedPhase = "os-available";
	// When reopened without another phase-change callback, package Update uses current state.
	const action = surface.installPackages();
	await flush();
	// Then the explicit OS-offer residual still uses legacy, never the stale scope.
	expect(sentCount("system.startUpdate")).toBe(1);
	expect(sentCount("system.installUpdatesNow")).toBe(0);
	answer("system.startUpdate", { success: true });
	await finishRead();
	await action;
});

it("a reopened dialog retains scoped routing when the package phase did not change", async () => {
	// Given a capable dialog reopened on the same phase, without another observePhase callback.
	const surface = await surfaceAt("available");
	surface.reset();
	// When packages are requested, then the current push still authorizes the scoped route.
	const action = surface.installPackages();
	await flush();
	expect(sentCount("system.installUpdatesNow")).toBe(1);
	expect(sentCount("system.startUpdate")).toBe(0);
	answer("system.installUpdatesNow", { success: true });
	await finishRead();
	await action;
});

async function finishRead(): Promise<void> {
	await flush();
	if (outstanding("system.getUpdateDetails").length)
		answer("system.getUpdateDetails", deviceDetails());
	await flush();
}

it.each(["available", "awaiting-idle"] as const)(
	"capable %s package click is scoped and settled by orchestrator evidence",
	async (phase) => {
		// Given a capable image with package-owned state.
		const surface = await surfaceAt(phase);
		// When the operator clicks twice before the reply.
		const first = surface.installPackages();
		const second = surface.installPackages();
		await flush();
		// Then only one scoped request owns the install action, not legacy settlement.
		expect(
			FakeWebSocket.log
				.filter((call) => call.path === "system.installUpdatesNow")
				.map((call) => call.input),
		).toEqual([{ scope: "packages" }]);
		expect(sentCount("system.startUpdate")).toBe(0);
		expect(surface.pending("install")).toBe(true);
		surface.observeLegacy("installing");
		expect(surface.pending("install")).toBe(true);
		const moved = surface.observePhase("downloading");
		answer("system.getUpdateDetails", deviceDetails());
		await moved;
		answer("system.installUpdatesNow", { success: true });
		await finishRead();
		await Promise.all([first, second]);
		expect(surface.pending("install")).toBe(false);
		expect(surface.bands).toEqual([]);
	},
);

it.each([
	["os-available", CAPABLE],
	["available", { mode: "legacy", features: [] }],
	["available", { mode: "capable", features: [] }],
	[undefined, CAPABLE],
] satisfies readonly [
	UpdateOrchestratorPhase | undefined,
	UpdateCapabilities,
][])(
	"%s without package authority keeps the legacy action (%j)",
	async (phase, capabilities) => {
		// Given an OS offer, absent orchestrator or an incapable image.
		const surface = await surfaceAt(phase, capabilities);
		// When packages are requested.
		const action = surface.installPackages();
		await flush();
		// Then the historical path is the only dispatched RPC.
		expect(sentCount("system.startUpdate")).toBe(1);
		expect(sentCount("system.installUpdatesNow")).toBe(0);
		answer("system.startUpdate", { success: true });
		await finishRead();
		await action;
	},
);

it.each(["busy", "not_available", "stream_active"])(
	"scoped %s refusal re-enables without legacy fallback",
	async (reason) => {
		// Given a scoped action whose server-side authority was lost.
		const surface = await surfaceAt("available");
		const action = surface.installPackages();
		await flush();
		// When the server refuses.
		answer("system.installUpdatesNow", { success: false, error: reason });
		await finishRead();
		await action;
		// Then the existing install band owns feedback, and no fallback was sent.
		expect(surface.refusal).toMatchObject({ action: "install", reason });
		expect(surface.pending("install")).toBe(false);
		expect(sentCount("system.startUpdate")).toBe(0);
	},
);
