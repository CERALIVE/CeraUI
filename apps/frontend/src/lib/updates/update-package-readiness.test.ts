// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	answer,
	CAPABLE,
	connectDevice,
	deviceDetails,
	disconnectDevice,
	dropLink,
	elapse,
	flush,
	outstanding,
	RPC_TIMEOUT_MS,
	reject,
	restoreLink,
	SETTINGS,
	sentCount,
} from "../../tests/helpers/update-device";
import { destroyAsyncOperations } from "../rpc/async-operation.svelte";
import { noteLinkState } from "../rpc/session-epoch.svelte";
import {
	createUpdateSurface,
	type UpdateSurface,
} from "./update-surface.svelte";

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getUpdateOrchestratorState: () => ({ phase: "available" }),
}));

beforeEach(() => {
	connectDevice();
	noteLinkState("connected");
});
afterEach(() => {
	destroyAsyncOperations();
	disconnectDevice();
	noteLinkState("disconnected");
});

// Answer any erroneously dispatched mutation too, so the red run leaves no work pending.
async function click(surface: UpdateSurface): Promise<void> {
	const action = surface.installPackages();
	await flush();
	const dispatched = ["system.startUpdate", "system.installUpdatesNow"].some(
		(path) => outstanding(path).length > 0,
	);
	for (const path of ["system.startUpdate", "system.installUpdatesNow"])
		if (outstanding(path).length)
			answer(path, { success: false, error: "busy" });
	await flush();
	if (dispatched)
		for (const request of outstanding("system.getUpdateDetails"))
			answer(request.path, deviceDetails());
	await action;
}

function expectNoInstall(): void {
	expect(sentCount("system.startUpdate")).toBe(0);
	expect(sentCount("system.installUpdatesNow")).toBe(0);
}

it.each([
	"system.getUpdateCapabilities",
	"system.getUpdateSettings",
	"system.getUpdateDetails",
])("does not install before the opening %s settles", async (held) => {
	// Given a new dialog whose package offer arrived before its opening reads finished.
	const surface = createUpdateSurface();
	const load = surface.load();
	if (held !== "system.getUpdateCapabilities")
		answer("system.getUpdateCapabilities", CAPABLE);
	if (held !== "system.getUpdateSettings")
		answer("system.getUpdateSettings", SETTINGS);
	if (held !== "system.getUpdateDetails")
		answer("system.getUpdateDetails", deviceDetails());
	await flush();
	// When the surface is invoked before that read settles.
	await click(surface);
	// Then unknown authority dispatches neither installer.
	expectNoInstall();
	if (held === "system.getUpdateCapabilities") answer(held, CAPABLE);
	if (held === "system.getUpdateSettings") answer(held, SETTINGS);
	if (held === "system.getUpdateDetails") answer(held, deviceDetails());
	await load;
});

it.each(["rejected", "timed out"])(
	"does not install after a %s capability read even though loading finished",
	async (failure) => {
		// Given a settled opening load with no declaration, on an otherwise capable device.
		const surface = createUpdateSurface();
		const load = surface.load();
		answer("system.getUpdateSettings", SETTINGS);
		answer("system.getUpdateDetails", deviceDetails());
		if (failure === "rejected")
			reject("system.getUpdateCapabilities", "INTERNAL_ERROR");
		else await elapse(RPC_TIMEOUT_MS);
		await load;
		expect(surface.loaded).toBe(true);
		expect(surface.detailsFailed).toBe(true);
		// When the operator tries the package action.
		await click(surface);
		// Then failure is not permission to use the legacy installer.
		expectNoInstall();
	},
);

it.each(["load", "reread", "rereadOnRestore"] as const)(
	"revokes a previous legacy declaration while %s reads a replacement image",
	async (method) => {
		// Given a legacy declaration on the previous dialog/link.
		const surface = createUpdateSurface();
		const load = surface.load();
		answer("system.getUpdateCapabilities", { mode: "legacy", features: [] });
		answer("system.getUpdateSettings", SETTINGS);
		answer("system.getUpdateDetails", deviceDetails());
		await load;
		const refresh = surface[method]();
		// When a click races a re-read that could report a different installed image.
		await click(surface);
		// Then the old legacy declaration grants no mutation authority.
		expectNoInstall();
		answer("system.getUpdateCapabilities", CAPABLE);
		answer("system.getUpdateSettings", SETTINGS);
		if (outstanding("system.getUpdateDetails").length)
			answer("system.getUpdateDetails", deviceDetails());
		await refresh;
	},
);

it("revokes legacy authority when the dialog closes", async () => {
	// Given a loaded legacy dialog.
	const surface = createUpdateSurface();
	const load = surface.load();
	answer("system.getUpdateCapabilities", { mode: "legacy", features: [] });
	answer("system.getUpdateSettings", SETTINGS);
	answer("system.getUpdateDetails", deviceDetails());
	await load;
	surface.reset();
	// When a stale confirmation invokes its action after close.
	await click(surface);
	// Then a closed session cannot authorize a legacy install.
	expectNoInstall();
});

it("does not reuse legacy authority on a new link before the restore read begins", async () => {
	// Given a legacy declaration from the previous connection.
	const surface = createUpdateSurface();
	const load = surface.load();
	answer("system.getUpdateCapabilities", { mode: "legacy", features: [] });
	answer("system.getUpdateSettings", SETTINGS);
	answer("system.getUpdateDetails", deviceDetails());
	await load;
	dropLink();
	noteLinkState("disconnected");
	await restoreLink();
	noteLinkState("connected");
	// When a click precedes completion of the restored session's hydration.
	await click(surface);
	// Then the old image's declaration cannot authorize a legacy install.
	expect(surface.packagesReady).toBe(false);
	expectNoInstall();
});
