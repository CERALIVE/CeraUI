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

it("does not install before the opening capability read settles", async () => {
	// Given a new dialog whose package offer arrived before its opening reads finished.
	const surface = createUpdateSurface();
	const load = surface.load();
	answer("system.getUpdateSettings", SETTINGS);
	answer("system.getUpdateDetails", deviceDetails());
	await flush();
	// When the surface is invoked before that read settles.
	await click(surface);
	// Then unknown authority dispatches neither installer.
	expectNoInstall();
	expect(surface.packagesReady).toBe(false);
	answer("system.getUpdateCapabilities", CAPABLE);
	await load;
});

it.each(["system.getUpdateSettings", "system.getUpdateDetails"])(
	"does not wait for the opening %s once capabilities and phase are known",
	async (held) => {
		// Given confirmed capabilities and phase, but an unrelated read still pending.
		const surface = createUpdateSurface();
		const load = surface.load();
		answer("system.getUpdateCapabilities", CAPABLE);
		if (held !== "system.getUpdateSettings")
			answer("system.getUpdateSettings", SETTINGS);
		if (held !== "system.getUpdateDetails")
			answer("system.getUpdateDetails", deviceDetails());
		await flush();
		// When the operator installs without waiting for settings or details.
		const action = surface.installPackages();
		await flush();
		// Then only the scoped route dispatches, without that ancillary dependency.
		expect(sentCount("system.startUpdate")).toBe(0);
		expect(sentCount("system.installUpdatesNow")).toBe(1);
		expect(surface.packagesReady).toBe(true);
		answer("system.installUpdatesNow", { success: false, error: "busy" });
		await flush();
		answer("system.getUpdateDetails", deviceDetails(), "newest");
		await action;
		answer(
			held,
			held === "system.getUpdateSettings" ? SETTINGS : deviceDetails(),
		);
		await load;
	},
);

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
		expect(surface.packagesReady).toBe(false);
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
		expect(surface.packagesReady).toBe(false);
		expect(surface.capabilities).toEqual({ mode: "legacy", features: [] });
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
	expect(surface.packagesReady).toBe(false);
});

it("does not let a superseded capability answer authorize an in-flight reread", async () => {
	// Given overlapping reads that could answer for different images.
	const surface = createUpdateSurface();
	const load = surface.load();
	const restore = surface.rereadOnRestore();
	answer("system.getUpdateCapabilities", { mode: "legacy", features: [] });
	await flush();
	// When the older legacy answer arrives before the current declaration.
	await click(surface);
	// Then that stale generation grants neither installer authority.
	expectNoInstall();
	expect(surface.packagesReady).toBe(false);
	answer("system.getUpdateCapabilities", CAPABLE);
	answer("system.getUpdateSettings", SETTINGS, "newest");
	answer("system.getUpdateSettings", SETTINGS);
	answer("system.getUpdateDetails", deviceDetails());
	await Promise.all([load, restore]);
	expect(surface.packagesReady).toBe(true);
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
	expectNoInstall();
	expect(surface.packagesReady).toBe(false);
});
