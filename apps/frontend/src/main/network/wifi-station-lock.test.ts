/**
 * The station-control lock: pending holds the controls, terminal ALWAYS releases
 * them (F-09).
 *
 * The property that matters most here is the absence of an eternal disable —
 * every phase behind this lock is terminal, so there is no input for which
 * `locked` stays true forever.
 */
import { describe, expect, it } from "vitest";

import type { AsyncOpPhase } from "$lib/rpc/async-operation.svelte";

import {
	deriveWifiStationLock,
	type WifiStationLockPhases,
	wifiHotspotOpKey,
	wifiModeOpKey,
} from "./wifi-station-lock";

const IDLE: WifiStationLockPhases = { hotspot: "idle", mode: "idle" };

const ALL_PHASES: readonly AsyncOpPhase[] = [
	"idle",
	"pending",
	"confirmed",
	"failed",
	"timed_out",
];

describe("op keys", () => {
	it("names the two transitions that hold an adapter", () => {
		expect(wifiHotspotOpKey("0")).toBe("hotspot:0");
		expect(wifiModeOpKey("0")).toBe("wifi-mode:0");
	});
});

describe("deriveWifiStationLock — the lock", () => {
	it("says nothing when the adapter is idle", () => {
		expect(deriveWifiStationLock(IDLE)).toEqual({ locked: false });
	});

	it("locks on a pending hotspot transition, with its own reason", () => {
		const lock = deriveWifiStationLock({ ...IDLE, hotspot: "pending" });
		expect(lock.locked).toBe(true);
		expect(lock.kind).toBe("hotspot");
		expect(lock.reasonKey).toBe("network.wifiStationLock.hotspotPending");
	});

	it("locks on a pending mode transition, with its own reason", () => {
		const lock = deriveWifiStationLock({ ...IDLE, mode: "pending" });
		expect(lock.locked).toBe(true);
		expect(lock.kind).toBe("mode");
		expect(lock.reasonKey).toBe("network.wifiStationLock.modePending");
	});

	it("names the MODE change when both keys are pending", () => {
		// `setWifiAdapterMode` delegates to the hotspot transaction, so one operator
		// action legitimately lights both. Naming the hotspot leg would report the
		// mechanism instead of what they actually did.
		const lock = deriveWifiStationLock({ hotspot: "pending", mode: "pending" });
		expect(lock.kind).toBe("mode");
	});

	it("never reports a lock and a failure at the same time", () => {
		const lock = deriveWifiStationLock({ hotspot: "failed", mode: "pending" });
		expect(lock.locked).toBe(true);
		expect(lock.failureTitleKey).toBeUndefined();
	});
});

describe("deriveWifiStationLock — the release", () => {
	it("releases on a confirmed transition and says nothing more", () => {
		expect(
			deriveWifiStationLock({ hotspot: "confirmed", mode: "confirmed" }),
		).toEqual({ locked: false });
	});

	it("releases on an explicit refusal and names what did not complete", () => {
		const lock = deriveWifiStationLock({ ...IDLE, hotspot: "failed" });
		expect(lock.locked).toBe(false);
		expect(lock.failureKind).toBe("hotspot");
		expect(lock.failureTitleKey).toBe("network.wifiStationLock.hotspotFailed");
		expect(lock.failureBodyKey).toBe("network.wifiStationLock.failedBody");
	});

	it("distinguishes a result that never arrived from one that was refused", () => {
		const lock = deriveWifiStationLock({ ...IDLE, mode: "timed_out" });
		expect(lock.locked).toBe(false);
		expect(lock.failureKind).toBe("mode");
		expect(lock.failureTitleKey).toBe("network.wifiStationLock.modeFailed");
		expect(lock.failureBodyKey).toBe("network.wifiStationLock.unconfirmedBody");
	});

	it("NO phase pair leaves the controls locked forever", () => {
		// The no-eternal-disable guarantee, asserted exhaustively rather than
		// asserted about: a lock exists only where a `pending` does.
		for (const hotspot of ALL_PHASES) {
			for (const mode of ALL_PHASES) {
				const lock = deriveWifiStationLock({ hotspot, mode });
				expect(lock.locked).toBe(hotspot === "pending" || mode === "pending");
			}
		}
	});
});
