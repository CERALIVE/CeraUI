// @vitest-environment jsdom
/**
 * Round-3 review C, through the REAL surface, `osCommand`, `RPCClient` and a
 * scripted socket on Vitest's fake clock: every conclusion the Updates dialog
 * draws must be one the device's evidence supports.
 *
 * C3-1 a `{ success: false }` reply after the device has ALREADY shown the
 *      install starting is not "Not started" (the OS-install producer answers
 *      from the END phase of a stage it ran).
 * C3-2 "no newer image" needs a check this dialog saw complete on the link it
 *      is reading over; a restart loses the memory-only candidate.
 * C3-3 a settings write owns its control until its request SETTLES, a lost
 *      reply is "not confirmed" (never "not saved"), and the next write is
 *      built from settings read after the click.
 */
import type { UpdateDetails, UpdateSettings } from "@ceraui/rpc/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	answer,
	CAPABLE,
	connectDevice,
	deviceDetails,
	disconnectDevice,
	dropLink,
	elapse,
	FakeWebSocket,
	flush,
	OFFERED,
	outstanding,
	RPC_TIMEOUT_MS,
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

async function openSurface(details = OFFERED): Promise<UpdateSurface> {
	const surface = createUpdateSurface();
	const opening = surface.load();
	answer("system.getUpdateCapabilities", CAPABLE);
	answer("system.getUpdateSettings", SETTINGS);
	answer("system.getUpdateDetails", details);
	await opening;
	return surface;
}

/** The device answers every settings read the dialog has outstanding. */
async function answerSettingsReads(device: UpdateSettings): Promise<void> {
	while (outstanding("system.getUpdateSettings").length > 0) {
		answer("system.getUpdateSettings", device);
		await flush();
	}
}

function writes(): unknown[] {
	return FakeWebSocket.log
		.filter((request) => request.path === "system.setUpdateSettings")
		.map((request) => request.input);
}

/** What the surface says about the last save, whatever its API calls it. */
function saveState(surface: UpdateSurface): string | undefined {
	const outcome = (surface as { saveOutcome?: { kind: string } }).saveOutcome;
	return outcome?.kind;
}

beforeEach(() => {
	connectDevice();
});

afterEach(() => {
	disconnectDevice();
	destroyAsyncOperations();
});

describe("C3-1: a negative reply after the device showed the start", () => {
	it("start observed -> {success:false} is never 'Not started'", async () => {
		// Given an install in flight.
		const surface = await openSurface();
		const install = surface.installNow();
		await flush();

		// When the device publishes the stage, it then fails, and only then the
		// reply arrives as the producer sends it: `not_available`.
		const staging = surface.observePhase("os-staging");
		answer("system.getUpdateDetails", OFFERED);
		await staging;
		const failed = surface.observePhase("failed");
		answer("system.getUpdateDetails", OFFERED);
		await failed;
		answer("system.installUpdatesNow", {
			success: false,
			error: "not_available",
		});
		await flush();
		answer("system.getUpdateDetails", OFFERED);
		await install;

		// Then no band says the request did not start; the phase says what happened.
		expect(surface.refusal).toBeUndefined();
		expect(surface.bands).toEqual([]);
	});

	it("start observed -> {success:false} without an outcome phase is never 'Not started' either", async () => {
		// Given an install the device has started staging.
		const surface = await openSurface();
		const install = surface.installNow();
		await flush();
		const staging = surface.observePhase("os-staging");
		answer("system.getUpdateDetails", OFFERED);
		await staging;

		// When the stage falls back to the offer and the reply is negative.
		answer("system.installUpdatesNow", {
			success: false,
			error: "not_available",
		});
		await flush();
		answer("system.getUpdateDetails", OFFERED);
		await install;

		// Then no "Not started".
		expect(surface.refusal).toBeUndefined();
	});

	it("still says 'Not started' for a {success:false} with no start evidence", async () => {
		// Given an install the device declines before acting.
		const surface = await openSurface();
		const install = surface.installNow();
		await flush();

		// When the refusal is the first thing the device says.
		answer("system.installUpdatesNow", { success: false, error: "busy" });
		await flush();
		answer("system.getUpdateDetails", OFFERED);
		await install;

		// Then the refusal is what the operator reads.
		expect(surface.refusal).toEqual({ action: "install", reason: "busy" });
	});

	it("keeps a pre-effect startup refusal 'Not started' even after a phase moved", async () => {
		// Given an install in flight, and the device publishing a staging phase of its own.
		const surface = await openSurface();
		const install = surface.installNow();
		await flush();
		const staging = surface.observePhase("os-staging");
		answer("system.getUpdateDetails", OFFERED);
		await staging;

		// When the reply is the envelope raised before any effect.
		FakeWebSocket.current?.deliver({
			id: outstanding("system.installUpdatesNow")[0]?.id,
			error: {
				message: "init",
				code: "UPDATE_ORCHESTRATOR_INITIALIZING",
				retryable: true,
			},
		});
		await flush();
		answer("system.getUpdateDetails", OFFERED);
		await install;

		// Then that request, positively, did not start.
		expect(surface.refusal?.reason).toBe("UPDATE_ORCHESTRATOR_INITIALIZING");
	});
});

function nothingFound(at: number): UpdateDetails {
	return deviceDetails({ checkedAt: at, candidate: null });
}

describe("C3-2: package phase + lost candidate memory", () => {
	it("does not conclude 'no newer image' after a restart lost the candidate", async () => {
		// Given an OS check that FOUND an image (held), read by the dialog.
		noteLinkState("connected");
		const surface = await openSurface(deviceDetails({ checkedAt: 2_000 }));
		expect(surface.osNothingNewer("available")).toBe(false);

		// When the backend restarts (the link drops and returns) and the
		// memory-only candidate is gone while the clock and a package phase stand.
		noteLinkState("disconnected");
		dropLink();
		await restoreLink();
		noteLinkState("connected");
		const reread = surface.reloadDetails();
		answer("system.getUpdateDetails", nothingFound(2_000));
		await reread;

		// Then nothing says there is no newer image.
		expect(surface.details?.os.candidate).toBeNull();
		expect(surface.osNothingNewer("available")).toBe(false);
	});

	it("does not take a clock that moved in a process the dialog never read as 'nothing'", async () => {
		// Given an open dialog that read the device once.
		noteLinkState("connected");
		const surface = await openSurface(nothingFound(1_000));

		// When, unseen, the old process finds an image at 2 s and holds it in a
		// recovery record, then restarts and loses the candidate from memory.
		noteLinkState("disconnected");
		dropLink();
		await restoreLink();
		noteLinkState("connected");
		const reread = surface.reloadDetails();
		answer("system.getUpdateDetails", nothingFound(2_000));
		await reread;

		// Then the new clock read over a NEW link is a baseline, not a verdict.
		expect(surface.osNothingNewer("idle")).toBe(false);
	});

	it("does not conclude it from a clock it only read, never saw move", async () => {
		// Given a dialog opened after the device's last check.
		const surface = await openSurface(nothingFound(2_000));

		// Then the old clock alone is no evidence.
		expect(surface.osNothingNewer("idle")).toBe(false);
	});

	it("concludes it once it saw a check complete with nothing offered, on one link", async () => {
		// Given an open dialog.
		const surface = await openSurface(nothingFound(2_000));

		// When the device completes a new check that finds nothing.
		const reread = surface.reloadDetails();
		answer("system.getUpdateDetails", nothingFound(3_000));
		await reread;

		// Then the verdict is shown, also through a later package phase.
		expect(surface.osNothingNewer("idle")).toBe(true);
		expect(surface.osNothingNewer("available")).toBe(true);
	});
});

describe("C3-3: settings saves", () => {
	it("save reply delayed > 15 s then second save: busy holds and nothing undoes the first", async () => {
		// Given an open dialog and a save whose reply is slow.
		const surface = await openSurface();
		const device: UpdateSettings = { ...SETTINGS };
		const first = surface.save({ packagesAuto: false });
		await flush();
		await answerSettingsReads(device);

		// When 16 s pass (past the shared operation valve) and the operator
		// picks another channel.
		await elapse(16_000);
		expect(surface.saving).toBe(true);
		const second = surface.save({ channel: "beta" });
		await flush();
		await answerSettingsReads(device);

		// Then no second write was put on the wire while the first is unsettled.
		expect(writes()).toHaveLength(1);
		expect(writes()[0]).toMatchObject({ packagesAuto: false });
		expect(await second).toBe(false);
		answer("system.setUpdateSettings", { ...SETTINGS, packagesAuto: false });
		expect(await first).toBe(true);
		expect(surface.saving).toBe(false);
	});

	it("lost reply after settings persisted: unconfirmed, re-read, never 'not saved'", async () => {
		// Given a save the device applies but whose reply never arrives.
		const surface = await openSurface();
		const save = surface.save({ packagesAuto: false });
		await flush();
		await answerSettingsReads(SETTINGS);
		await elapse(RPC_TIMEOUT_MS + 1_000);
		await save;

		// Then the outcome is not confirmed, and the dialog asks the device again.
		expect(saveState(surface)).toBe("unconfirmed");
		const reads = outstanding("system.getUpdateSettings");
		expect(reads.length).toBeGreaterThan(0);

		// When that read shows the device did persist the change.
		await answerSettingsReads({ ...SETTINGS, packagesAuto: false });

		// Then the screen shows the device's value and the doubt is gone.
		expect(surface.settings?.packagesAuto).toBe(false);
		expect(saveState(surface)).toBeUndefined();
	});

	it("builds the next write from settings read after the click, not a stale snapshot", async () => {
		// Given an open dialog, and another client changing the channel since.
		const surface = await openSurface();
		const remote: UpdateSettings = { ...SETTINGS, channel: "beta" };

		// When the operator turns off package automation.
		const save = surface.save({ packagesAuto: false });
		await flush();
		await answerSettingsReads(remote);
		await flush();

		// Then the write keeps the newer remote channel.
		expect(writes()).toHaveLength(1);
		expect(writes()[0]).toMatchObject({ packagesAuto: false, channel: "beta" });
		answer("system.setUpdateSettings", { ...remote, packagesAuto: false });
		await save;
	});

	it("re-reads the settings when a dropped session is restored", async () => {
		// Given an open dialog.
		const surface = await openSurface();
		const before = sentCount("system.getUpdateSettings");

		// When the session is restored after a drop.
		dropLink();
		await restoreLink();
		void surface.reread();
		await flush();

		// Then the settings are read again.
		expect(sentCount("system.getUpdateSettings")).toBeGreaterThan(before);
	});
});
