// @vitest-environment jsdom
/**
 * What the Updates dialog may conclude about an operator action, from each kind
 * of evidence, through the real transport (round-2 review C: M1, m1, m2).
 *
 * Only a positive pre-dispatch answer is "Not started": an explicit
 * `{ success: false }`, the startup envelope, or a request the client never
 * sent. An error the device raised while HANDLING the request proves nothing
 * about whether it started, so it is reconciled against what the device
 * reports. A click the store declined to send owns nothing, and the busy state
 * lasts for the whole awaited chain of a two-call action.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	answer,
	CAPABLE,
	CELLULAR_ID,
	connectDevice,
	deviceDetails,
	disconnectDevice,
	dropLink,
	elapse,
	flush,
	OFFERED,
	OFFERED_VERSION,
	outstanding,
	RPC_TIMEOUT_MS,
	reject,
	SETTINGS,
	STAGED,
	sentCount,
} from "../../tests/helpers/update-device";
import { destroyAsyncOperations } from "../rpc/async-operation.svelte";
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

beforeEach(() => {
	connectDevice();
});

afterEach(() => {
	disconnectDevice();
	destroyAsyncOperations();
});

describe("an error the device raised while handling the request (M1)", () => {
	it("is not 'Not started' once the device has shown the image staged", async () => {
		// Given an install in flight.
		const surface = await openSurface();
		const install = surface.installNow();
		await flush();

		// When the device publishes the stage and a fresh read shows it…
		const phaseRead = surface.observePhase("os-staged");
		answer("system.getUpdateDetails", STAGED);
		await phaseRead;
		// …and only then the awaited request fails with an internal error.
		reject("system.installUpdatesNow", "INTERNAL_ERROR");
		await flush();
		answer("system.getUpdateDetails", STAGED);
		await install;

		// Then the confirmed start stands: no band claims otherwise.
		expect(surface.details?.os.staged?.version).toBe(OFFERED_VERSION);
		expect(surface.refusal).toBeUndefined();
		expect(surface.unconfirmed).toBeUndefined();
	});

	it("is unconfirmed until the device settles it, never refused", async () => {
		// Given an install whose request fails inside the handler.
		const surface = await openSurface();
		const install = surface.installNow();
		await flush();
		reject("system.installUpdatesNow", "INTERNAL_ERROR");
		await flush();
		answer("system.getUpdateDetails", OFFERED);
		await install;

		// Then nobody knows yet whether it started.
		expect(surface.refusal).toBeUndefined();
		expect(surface.unconfirmed).toBe("install");

		// When the device's phase shows the stage running.
		const phaseRead = surface.observePhase("os-staging");
		answer("system.getUpdateDetails", OFFERED);
		await phaseRead;

		// Then the uncertainty is settled by the device itself.
		expect(surface.unconfirmed).toBeUndefined();
		expect(surface.refusal).toBeUndefined();
	});

	it("treats a validation envelope as uncertain too: the output schema runs after the handler", async () => {
		// Given a check whose answer fails the reply schema.
		const surface = await openSurface();
		const check = surface.checkNow();
		await flush();
		reject("system.checkUpdatesNow", "VALIDATION_ERROR");
		await flush();
		answer("system.getUpdateDetails", OFFERED);
		await check;

		// Then it is not reported as refused.
		expect(surface.refusal).toBeUndefined();
		expect(surface.unconfirmed).toBe("check");
	});
});

describe("a request the client never sent", () => {
	it("is not started, and says why, instead of an outcome nobody waited for", async () => {
		// Given an open dialog whose link has just dropped.
		const surface = await openSurface();
		dropLink();

		// When the operator checks.
		const check = surface.checkNow();
		await flush();
		await check;

		// Then nothing went out, and the dialog says so.
		expect(sentCount("system.checkUpdatesNow")).toBe(0);
		expect(surface.refusal).toEqual({
			action: "check",
			reason: "not_connected",
		});
		expect(surface.unconfirmed).toBeUndefined();
	});
});

describe("a click the async-operation store declined (m1)", () => {
	it("leaves the dispatched install's watch alone, so its lost reply still reads unconfirmed", async () => {
		// Given an install in flight.
		const surface = await openSurface();
		const first = surface.installNow();
		await flush();

		// When a duplicate click is declined while the first is still waiting.
		await surface.installNow();

		// Then the duplicate changed nothing: no band, the first still awaited.
		expect(surface.bands).toEqual([]);
		expect(surface.pending("install")).toBe(true);

		// When the first request's reply never arrives.
		await elapse(RPC_TIMEOUT_MS + 1_000);
		answer("system.getUpdateDetails", OFFERED);
		await first;

		// Then exactly one request went out, and its uncertainty is reported.
		expect(sentCount("system.installUpdatesNow")).toBe(1);
		expect(surface.unconfirmed).toBe("install");
		expect(surface.refusal).toBeUndefined();
		expect(surface.pending("install")).toBe(false);
	});
});

describe("a cellular approval is ONE action of two requests (m2)", () => {
	it("stays busy until the download request settles, and admits no second approval meanwhile", async () => {
		// Given a held system image awaiting cellular approval.
		const surface = await openSurface(
			deviceDetails({
				pendingCellular: { id: CELLULAR_ID, sizeBytes: 734_003_200 },
			}),
		);
		const approval = surface.approveCellular(CELLULAR_ID);
		await flush();

		// When the approval answers after 29 s and the download request then hangs.
		await elapse(29_000);
		answer("system.allowCellularOnce", { success: true });
		await flush();
		expect(outstanding("system.installUpdatesNow")).toHaveLength(1);
		await elapse(7_000);

		// Then, 36 s in, the action is still busy and a second click sends nothing.
		expect(surface.pending("cellular")).toBe(true);
		const second = surface.approveCellular(CELLULAR_ID);
		await flush();
		expect(sentCount("system.allowCellularOnce")).toBe(1);
		await elapse(20_000);
		expect(surface.pending("cellular")).toBe(true);

		// When the download request's own timeout ends the chain.
		await elapse(4_000);
		answer("system.getUpdateDetails", OFFERED);
		await approval;
		await second;

		// Then the busy state ends with it, and the outcome is honest.
		expect(surface.pending("cellular")).toBe(false);
		expect(surface.unconfirmed).toBe("cellular");
		expect(sentCount("system.allowCellularOnce")).toBe(1);
		expect(sentCount("system.installUpdatesNow")).toBe(1);
	});
});
