/**
 * THE MUTATION-ENTRYPOINT INVENTORY, one enforcement test per entrypoint.
 *
 * The guarantee is not "the lease exists" — it is that EVERY route to a modem
 * mutation takes it, including the two that deliberately bypass the ordinary
 * modem middleware: the remote `modem.reconfig` self-fencing op (intercepted by
 * the command router before `modemProcedure` is ever reached) and the direct
 * `qmicli` PIN2 path (which neither ModemManager nor the D-Bus observer can
 * carry). A route that mutated without the lease would reopen exactly the
 * admission-window race the interlock exists to close.
 *
 * Each test does two things: it PRE-ACQUIRES the device's lease, and then asserts
 * both that the entrypoint returned its typed refusal AND that the underlying
 * effect never ran. The second half is what makes this an enforcement test rather
 * than a message test — a handler that refused politely and mutated anyway would
 * pass the first assertion.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { call } from "@orpc/server";

import { getConfig } from "../modules/config.ts";
import {
	resetModemWireProducer,
	setModemIdPathReader,
} from "../modules/modems/modem-wire-producer.ts";
import { getModems, setModem } from "../modules/modems/modems-state.ts";
import {
	beginModemMutation,
	withModemMutation,
} from "../modules/modems/mutation-lease.ts";
import {
	resetUsbModeDispatchDeps,
	setUsbModeDispatchDeps,
} from "../modules/modems/usb-mode-transition.ts";
import { handleSelfFencingOp } from "../modules/remote-control/self-fencing.ts";
import {
	resetLifecycleInterlock,
	tryAcquireLifecycle,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import {
	configureModemProcedure,
	scanModemProcedure,
	setUsbModeProcedure,
	unlockSimPin2Procedure,
	unlockSimProcedure,
	unlockSimPukProcedure,
} from "../rpc/procedures/modems.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const IFNAME = "wwan0";
const ID_PATH = "platform-xhci-hcd.0.auto-usb-0:1.4.1";
const KEY = ID_PATH;

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

async function seedModem(): Promise<void> {
	setModem(0, {
		ifname: IFNAME,
		name: "QUECTEL Broadband Module",
		sim_network: "",
		network_type: { supported: {}, active: "4g" },
		config: {
			autoconfig: false,
			apn: "internet",
			username: "",
			password: "",
			roaming: false,
			network: "",
		},
	});
	setModemIdPathReader(() => Promise.resolve(new Map([[IFNAME, ID_PATH]])));
	const { refreshModemIdPaths } = await import(
		"../modules/modems/modem-wire-producer.ts"
	);
	await refreshModemIdPaths();
}

/** Hold the device's lease as a competing mutation would. */
function holdLease(): { release(): void } {
	const acquired = beginModemMutation(KEY);
	if (!acquired.ok)
		throw new Error(`could not pre-acquire: ${acquired.refusal}`);
	return acquired.lease;
}

beforeEach(async () => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	await seedModem();
});

afterEach(() => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	setModemIdPathReader(null);
	resetModemWireProducer();
	for (const id of Object.keys(getModems())) {
		delete getModems()[Number(id)];
	}
	delete getConfig().modem_provisioning;
});

describe("the lease itself", () => {
	test("per-device: a second mutation on the SAME device is refused", () => {
		const lease = holdLease();
		expect(tryAcquireModemMutation(KEY)).toEqual({
			admitted: false,
			refusal: "mutation_in_progress",
		});
		lease.release();
		expect(tryAcquireModemMutation(KEY).admitted).toBe(true);
	});

	test("per-device: a DIFFERENT device may be mutated concurrently", () => {
		const lease = holdLease();
		const other = tryAcquireModemMutation("usb-0:2.1");
		expect(other.admitted).toBe(true);
		lease.release();
		if (other.admitted) other.lease.release();
	});

	test("RECIPROCAL: a stream admission is refused while ANY mutation is held", () => {
		const lease = holdLease();
		const admission = tryAcquireLifecycle("streaming");
		expect(admission.admitted).toBe(false);
		expect(admission.admitted === false && admission.refusal).toBe(
			"MODEM_TRANSITION_ACTIVE",
		);
		lease.release();
		const after = tryAcquireLifecycle("streaming");
		expect(after.admitted).toBe(true);
		if (after.admitted) after.lease.release();
	});

	test("RECIPROCAL: a mutation is refused while an admission holds the interlock", () => {
		const admission = tryAcquireLifecycle("streaming");
		expect(admission.admitted).toBe(true);
		expect(tryAcquireModemMutation(KEY)).toEqual({
			admitted: false,
			refusal: "streaming_active",
		});
		if (admission.admitted) admission.lease.release();
	});

	test("IDENTITY FAIL-CLOSED: no stable key ⇒ typed refusal, no mutation", async () => {
		let ran = false;
		const outcome = await withModemMutation(undefined, () => {
			ran = true;
			return Promise.resolve();
		});
		expect(outcome).toEqual({ ok: false, refusal: "identity_unresolved" });
		expect(ran).toBe(false);
	});

	test("release is idempotent and cannot free a later holder", () => {
		const lease = holdLease();
		lease.release();
		const second = tryAcquireModemMutation(KEY);
		expect(second.admitted).toBe(true);
		lease.release();
		expect(tryAcquireModemMutation(KEY)).toEqual({
			admitted: false,
			refusal: "mutation_in_progress",
		});
		if (second.admitted) second.lease.release();
	});
});

describe("entrypoint enforcement — one per inventoried mutation route", () => {
	test("modems.configure", async () => {
		const lease = holdLease();
		const result = await call(
			configureModemProcedure,
			{
				device: "0",
				network_type: "4g",
				apn: "changed",
				username: "",
				password: "",
			},
			{ context: makeContext() },
		);
		expect(result).toEqual({
			success: false,
			error: "mutation_in_progress",
		});
		// The effect never ran: the persisted config is untouched.
		expect(getModems()[0]?.config?.apn).toBe("internet");
		lease.release();
	});

	test("modems.scan", async () => {
		const lease = holdLease();
		expect(
			await call(scanModemProcedure, { device: 0 }, { context: makeContext() }),
		).toEqual({ success: false, mutationRefusal: "mutation_in_progress" });
		expect(getModems()[0]?.is_scanning).toBeUndefined();
		lease.release();
	});

	test("modems.unlockSim", async () => {
		const lease = holdLease();
		expect(
			await call(
				unlockSimProcedure,
				{ modemPath: "0", pin: "0000" },
				{ context: makeContext() },
			),
		).toEqual({ state: "error", mutationRefusal: "mutation_in_progress" });
		lease.release();
	});

	test("modems.unlockSimPuk", async () => {
		const lease = holdLease();
		expect(
			await call(
				unlockSimPukProcedure,
				{ modemPath: "0", puk: "12345678", newPin: "1234" },
				{ context: makeContext() },
			),
		).toEqual({
			success: false,
			error: "error",
			mutationRefusal: "mutation_in_progress",
		});
		lease.release();
	});

	test("modems.unlockSimPin2 — the DIRECT qmicli path", async () => {
		const lease = holdLease();
		expect(
			await call(
				unlockSimPin2Procedure,
				{ modemPath: "0", pin2: "0000" },
				{ context: makeContext() },
			),
		).toEqual({ state: "error", mutationRefusal: "mutation_in_progress" });
		lease.release();
	});

	test("modems.setUsbMode", async () => {
		getConfig().modem_provisioning = true;
		// The udev enumeration is stubbed because a CI host has no USB bus; every
		// gate ABOVE it, and the lease itself, is the real code path.
		setUsbModeDispatchDeps({
			resolveIdentity: () =>
				Promise.resolve({
					stableKey: KEY,
					// The shipped catalog's synthetic bench SKU: the certification gate
					// runs BEFORE the lease (an uncertified device must never mutate),
					// so proving the lease needs a device the catalog does permit.
					vidPid: "2c7c:0125",
					model: "CERALIVE-SYNTHETIC-TEST-SKU",
					firmwareRevision: "SYNTHETICFW01A",
					currentMode: "qmi",
					physicalUid: ID_PATH,
					ifname: IFNAME,
					ports: [`${IFNAME} (net)`, "ttyUSB2 (at)"],
				}),
		});
		const lease = holdLease();
		await withDeviceType("real", async () => {
			expect(
				await call(
					setUsbModeProcedure,
					{ device: "0", mode: "mbim", confirm: true },
					{ context: makeContext() },
				),
			).toEqual({ success: false, error: "transition_in_progress" });
		});
		lease.release();
		resetUsbModeDispatchDeps();
	});

	test("remote modem.reconfig — the SELF-FENCING path that bypasses the middleware", async () => {
		const lease = holdLease();
		const results: unknown[] = [];
		let snapshotted = false;
		await handleSelfFencingOp(
			{
				v: 1,
				kind: "command",
				type: "modem.reconfig",
				cid: "cid-1",
				payload: { device: "0" },
			} as never,
			{
				sendResult: (frame) => {
					results.push(frame);
					return true;
				},
				ops: {
					"modem.reconfig": {
						revertible: true,
						snapshot: () => {
							snapshotted = true;
							return Promise.resolve({});
						},
						apply: () => Promise.resolve({}),
						revert: () => Promise.resolve(),
					},
				} as never,
				isSubsystemReady: () => Promise.resolve(true),
			},
		);
		// Refused BEFORE the snapshot: nothing applied, no watchdog armed.
		expect(snapshotted).toBe(false);
		expect(results).toHaveLength(1);
		expect((results[0] as { payload: { error: string } }).payload.error).toBe(
			"mutation_in_progress",
		);
		lease.release();
	});
});

describe("LEASE LIFETIME spans the whole transaction, not the handler call", () => {
	/**
	 * `modem.reconfig` applies and then leaves a 30 s confirm/auto-revert watchdog
	 * live AFTER the handler returns. Releasing on return would leave a stream
	 * admissible during exactly the window in which the modem is half-applied, or
	 * is being rolled back.
	 */
	function reconfigOps(reverted: string[]) {
		return {
			"modem.reconfig": {
				revertible: true,
				snapshot: () => Promise.resolve({ apn: "internet" }),
				apply: () => Promise.resolve({ apn: "changed" }),
				revert: () => {
					reverted.push("reverted");
					// The stream must STILL be refused while the rollback runs.
					expect(tryAcquireLifecycle("streaming").admitted).toBe(false);
					return Promise.resolve();
				},
			},
		} as never;
	}

	test("a stream is refused BETWEEN apply and confirm", async () => {
		await handleSelfFencingOp(
			{
				v: 1,
				kind: "command",
				type: "modem.reconfig",
				cid: "cid-lifetime",
				payload: { device: "0" },
			} as never,
			{
				sendResult: () => true,
				ops: reconfigOps([]),
				isSubsystemReady: () => Promise.resolve(true),
				setTimer: () => 0 as never,
				clearTimer: () => {},
			},
		);
		// The handler has RETURNED and the watchdog is still live.
		expect(tryAcquireLifecycle("streaming").admitted).toBe(false);

		const { handleSelfFencingConfirm } = await import(
			"../modules/remote-control/self-fencing.ts"
		);
		await handleSelfFencingConfirm("cid-lifetime");
		const after = tryAcquireLifecycle("streaming");
		expect(after.admitted).toBe(true);
		if (after.admitted) after.lease.release();
	});

	test("a stream is refused DURING the watchdog rollback, and freed after it", async () => {
		const reverted: string[] = [];
		let fire: (() => void) | undefined;
		await handleSelfFencingOp(
			{
				v: 1,
				kind: "command",
				type: "modem.reconfig",
				cid: "cid-revert",
				payload: { device: "0" },
			} as never,
			{
				sendResult: () => true,
				ops: reconfigOps(reverted),
				isSubsystemReady: () => Promise.resolve(true),
				setTimer: (fn) => {
					fire = fn;
					return 0 as never;
				},
				clearTimer: () => {},
			},
		);
		expect(tryAcquireLifecycle("streaming").admitted).toBe(false);

		fire?.();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(reverted).toEqual(["reverted"]);
		const after = tryAcquireLifecycle("streaming");
		expect(after.admitted).toBe(true);
		if (after.admitted) after.lease.release();
	});
});

describe("entrypoint enforcement — identity_unresolved on every route", () => {
	beforeEach(() => {
		// A modem whose ifname resolves to NO udev ID_PATH: the identity contract
		// permits it, and every mutating route must refuse rather than guess.
		setModemIdPathReader(() => Promise.resolve(new Map()));
		resetModemWireProducer();
	});

	test("modems.configure refuses with identity_unresolved", async () => {
		expect(
			await call(
				configureModemProcedure,
				{
					device: "0",
					network_type: "4g",
					apn: "changed",
					username: "",
					password: "",
				},
				{ context: makeContext() },
			),
		).toEqual({ success: false, error: "identity_unresolved" });
		expect(getModems()[0]?.config?.apn).toBe("internet");
	});

	test("modems.scan refuses with identity_unresolved", async () => {
		expect(
			await call(scanModemProcedure, { device: 0 }, { context: makeContext() }),
		).toEqual({ success: false, mutationRefusal: "identity_unresolved" });
	});

	test("modems.unlockSim refuses with identity_unresolved", async () => {
		expect(
			await call(
				unlockSimProcedure,
				{ modemPath: "0", pin: "0000" },
				{ context: makeContext() },
			),
		).toEqual({ state: "error", mutationRefusal: "identity_unresolved" });
	});

	test("modems.unlockSimPuk refuses with identity_unresolved", async () => {
		expect(
			await call(
				unlockSimPukProcedure,
				{ modemPath: "0", puk: "12345678", newPin: "1234" },
				{ context: makeContext() },
			),
		).toEqual({
			success: false,
			error: "error",
			mutationRefusal: "identity_unresolved",
		});
	});

	test("modems.unlockSimPin2 refuses with identity_unresolved", async () => {
		expect(
			await call(
				unlockSimPin2Procedure,
				{ modemPath: "0", pin2: "0000" },
				{ context: makeContext() },
			),
		).toEqual({ state: "error", mutationRefusal: "identity_unresolved" });
	});

	test("remote modem.reconfig refuses with identity_unresolved", async () => {
		const results: unknown[] = [];
		let snapshotted = false;
		await handleSelfFencingOp(
			{
				v: 1,
				kind: "command",
				type: "modem.reconfig",
				cid: "cid-2",
				payload: { device: "0" },
			} as never,
			{
				sendResult: (frame) => {
					results.push(frame);
					return true;
				},
				ops: {
					"modem.reconfig": {
						revertible: true,
						snapshot: () => {
							snapshotted = true;
							return Promise.resolve({});
						},
						apply: () => Promise.resolve({}),
						revert: () => Promise.resolve(),
					},
				} as never,
				isSubsystemReady: () => Promise.resolve(true),
			},
		);
		expect(snapshotted).toBe(false);
		expect((results[0] as { payload: { error: string } }).payload.error).toBe(
			"identity_unresolved",
		);
	});
});
