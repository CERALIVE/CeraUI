/**
 * The certified transition engine, WIRED — driven end to end over mock transport.
 *
 * What is exercised here is modem-stack's real `UsbModeTransition` (its ordering,
 * its AT allowlist, and its postcondition), built by CeraUI's own
 * `createTransitionEngine` from injected ports. Only the four I/O ports are
 * doubles; every gate, the catalog match, the journal, the lease and the
 * postcondition are the shipped code.
 *
 * The postcondition is the reason this suite matters more than a mock of the
 * engine would: an AT `OK` proves nothing, and a device that answers `OK` and
 * re-enumerates as the WRONG thing has to fail. Both are asserted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsbDeviceSnapshot } from "@ceralive/modem-control";
import { call } from "@orpc/server";

import { getConfig } from "../modules/config.ts";
import {
	defaultMutationJournalFs,
	readMutationEntry,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import {
	clearMutationRollbacks,
	resetMutationCaptureDeps,
	setMutationCaptureDeps,
} from "../modules/modems/mutation-rollback.ts";
import {
	createTransitionEngine,
	findAtPort,
} from "../modules/modems/transition-engine.ts";
import {
	resetUsbModeDispatchDeps,
	setUsbModeDispatchDeps,
} from "../modules/modems/usb-mode-transition.ts";
import { resetLifecycleInterlock } from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import { setUsbModeProcedure } from "../rpc/procedures/modems.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.1";
const SKU = {
	vidPid: "2c7c:0125",
	model: "CERALIVE-SYNTHETIC-TEST-SKU",
	firmwareRevision: "SYNTHETICFW01A",
};

// The synthetic SKU's certified qmi→mbim transition expects exactly these.
const MBIM_IFACES = [
	{ interfaceClass: 2, interfaceSubClass: 14, interfaceProtocol: 0 },
	{ interfaceClass: 10, interfaceSubClass: 0, interfaceProtocol: 2 },
];
const QMI_IFACES = [
	{
		interfaceClass: 255,
		interfaceSubClass: 255,
		interfaceProtocol: 255,
		driver: "qmi_wwan",
	},
];

let dir: string;

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

function device(
	interfaces: ReadonlyArray<Record<string, number | string>>,
): UsbDeviceSnapshot {
	return {
		vendorId: "2c7c",
		productId: "0125",
		model: SKU.model,
		firmwareRevision: SKU.firmwareRevision,
		bDeviceClass: 0,
		ifname: "wwan0",
		physicalUid: KEY,
		interfaces,
	} as unknown as UsbDeviceSnapshot;
}

/**
 * A scripted USB bus: the FIRST reads answer with the pre-switch composition, the
 * port then drops, and the device returns with `after`. That is the exact shape
 * the transaction polls for (drop, then same-physical-UID re-enumeration).
 */
function scriptedBus(after: ReadonlyArray<Record<string, number | string>>): {
	enumerate: () => Promise<readonly UsbDeviceSnapshot[]>;
	readonly at: string[];
} {
	const at: string[] = [];
	let phase: "before" | "dropped" | "after" = "before";
	return {
		at,
		enumerate: () => {
			if (phase === "before") {
				// The AT command is what moves it on; until then it is present.
				if (at.length === 0) return Promise.resolve([device(QMI_IFACES)]);
				phase = "dropped";
				return Promise.resolve([]);
			}
			if (phase === "dropped") {
				phase = "after";
				return Promise.resolve([]);
			}
			return Promise.resolve([device(after)]);
		},
	};
}

function engineDeps(bus: ReturnType<typeof scriptedBus>, activated: string[]) {
	return {
		actor: new (class {
			run<T>(_key: string, task: () => Promise<T>): Promise<T> {
				return task();
			}
		})() as never,
		nm: {
			acquireQuiesceLease: () => Promise.resolve({ id: "lease" }),
			releaseQuiesceLease: () => Promise.resolve(),
			activate: (_id: string, ifname: string) => {
				activated.push(ifname);
				return Promise.resolve({});
			},
		} as never,
		inhibitPort: {
			inhibit: (uid: string) =>
				Promise.resolve({ uid, acquiredAt: 0 as never }),
			uninhibit: () => Promise.resolve(),
		},
		createAtSender: () => ({
			send: (command: string) => {
				bus.at.push(command);
				return Promise.resolve({ ok: true, raw: "OK" });
			},
		}),
		enumerate: bus.enumerate,
	};
}

function useDispatch(
	overrides: Parameters<typeof setUsbModeDispatchDeps>[0],
): void {
	setUsbModeDispatchDeps({
		resolveIdentity: () =>
			Promise.resolve({
				stableKey: KEY,
				vidPid: SKU.vidPid,
				model: SKU.model,
				firmwareRevision: SKU.firmwareRevision,
				currentMode: "qmi",
				physicalUid: KEY,
				ifname: "wwan0",
				ports: ["wwan0 (net)", "ttyUSB2 (at)"],
			}),
		resolveConnectionId: () => Promise.resolve("uuid-1"),
		resolveInhibitUid: () => Promise.resolve(KEY),
		confirmDataPath: () => Promise.resolve(true),
		rediscover: () => Promise.resolve(),
		now: () => 1_000,
		...overrides,
	});
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ceraui-transition-engine-"));
	setMutationJournalDeps({
		fs: defaultMutationJournalFs,
		dir,
		now: () => 2_000,
	});
	setMutationCaptureDeps({ enumerate: () => Promise.resolve([]) });
	clearMutationRollbacks();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	getConfig().modem_provisioning = true;
});

afterEach(async () => {
	resetUsbModeDispatchDeps();
	resetMutationJournalDeps();
	resetMutationCaptureDeps();
	clearMutationRollbacks();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	updateStatus(false);
	delete getConfig().modem_provisioning;
	await rm(dir, { recursive: true, force: true });
});

describe("the AT port is resolved from ModemManager's own list", () => {
	test("the `(at)` entry is picked, and nothing else is", () => {
		expect(findAtPort(["wwan0 (net)", "cdc-wdm0 (qmi)", "ttyUSB2 (at)"])).toBe(
			"ttyUSB2",
		);
		expect(findAtPort(["wwan0 (net)", "cdc-wdm0 (qmi)"])).toBeUndefined();
	});

	test("a modem with NO AT port yields NO engine — never a fabricated one", () => {
		expect(
			createTransitionEngine({ stableKey: KEY, ports: ["wwan0 (net)"] }),
		).toBeUndefined();
	});
});

describe("the full gate chain with the engine wired", () => {
	test("a certified switch runs the transaction and cancels the armed rollback", async () => {
		const bus = scriptedBus(MBIM_IFACES);
		const activated: string[] = [];
		useDispatch({
			createEngine: (identity) =>
				createTransitionEngine(
					{ stableKey: identity.stableKey, ports: identity.ports },
					engineDeps(bus, activated),
				),
		});

		let result: unknown;
		await withDeviceType("real", async () => {
			result = await call(
				setUsbModeProcedure,
				{ device: "0", mode: "mbim", confirm: true },
				{ context: makeContext() },
			);
		});
		expect(result).toEqual({ success: true });
		// The catalog's AT command for qmi→mbim, sent exactly once.
		expect(bus.at).toEqual(['AT+QCFG="usbnet",2']);
		expect(activated).toEqual(["wwan0"]);
		// Confirmed ⇒ the armed journal entry is gone.
		expect(await readMutationEntry(KEY)).toBeUndefined();
	});

	test("an OK that re-enumerates as the WRONG thing FAILS and stays blocked", async () => {
		// The device answers OK and comes back still QMI — the postcondition, not
		// the AT reply, is what decides.
		const bus = scriptedBus(QMI_IFACES);
		useDispatch({
			createEngine: (identity) =>
				createTransitionEngine(
					{ stableKey: identity.stableKey, ports: identity.ports },
					engineDeps(bus, []),
				),
		});

		let result: unknown;
		await withDeviceType("real", async () => {
			result = await call(
				setUsbModeProcedure,
				{ device: "0", mode: "mbim", confirm: true },
				{ context: makeContext() },
			);
		});
		expect(result).toEqual({
			success: false,
			error: "transition_failed",
			reason: "postcondition_mismatch",
		});
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
	});

	test("a switch that lands but never restores the DATA PATH stays blocked", async () => {
		const bus = scriptedBus(MBIM_IFACES);
		useDispatch({
			createEngine: (identity) =>
				createTransitionEngine(
					{ stableKey: identity.stableKey, ports: identity.ports },
					engineDeps(bus, []),
				),
			confirmDataPath: () => Promise.resolve(false),
		});

		let result: unknown;
		await withDeviceType("real", async () => {
			result = await call(
				setUsbModeProcedure,
				{ device: "0", mode: "mbim", confirm: true },
				{ context: makeContext() },
			);
		});
		expect(result).toEqual({
			success: false,
			error: "transition_failed",
			reason: "postcondition_mismatch",
		});
		const entry = await readMutationEntry(KEY);
		expect(entry?.state).toBe("failed");
		expect(entry?.detail).toContain("data path");
	});

	test("an ENGINE ERROR is reported typed, and the device stays blocked", async () => {
		useDispatch({
			createEngine: () => ({
				execute: () => Promise.reject(new Error("transport exploded")),
			}),
		});
		let result: unknown;
		await withDeviceType("real", async () => {
			result = await call(
				setUsbModeProcedure,
				{ device: "0", mode: "mbim", confirm: true },
				{ context: makeContext() },
			);
		});
		expect(result).toEqual({
			success: false,
			error: "transition_failed",
			reason: "transaction_error",
		});
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
	});

	test("an UNKNOWN FIRMWARE is uncertified, and fires ZERO engine calls", async () => {
		let built = 0;
		useDispatch({
			resolveIdentity: () =>
				Promise.resolve({
					stableKey: KEY,
					vidPid: SKU.vidPid,
					model: SKU.model,
					// One character short of the certified family prefix.
					firmwareRevision: "SYNTHETICFW0",
					currentMode: "qmi",
					physicalUid: KEY,
					ifname: "wwan0",
					ports: ["ttyUSB2 (at)"],
				}),
			createEngine: () => {
				built += 1;
				return undefined;
			},
		});
		let result: unknown;
		await withDeviceType("real", async () => {
			result = await call(
				setUsbModeProcedure,
				{ device: "0", mode: "mbim", confirm: true },
				{ context: makeContext() },
			);
		});
		expect(result).toEqual({ success: false, error: "uncertified" });
		expect(built).toBe(0);
		// An uncertified device is never journaled either — nothing was mutated.
		expect(await readMutationEntry(KEY)).toBeUndefined();
	});

	test("a LIVE STREAM is refused before anything is resolved", async () => {
		let resolved = 0;
		useDispatch({
			resolveIdentity: () => {
				resolved += 1;
				return Promise.resolve(undefined);
			},
		});
		updateStatus(true);
		let result: unknown;
		await withDeviceType("real", async () => {
			result = await call(
				setUsbModeProcedure,
				{ device: "0", mode: "mbim", confirm: true },
				{ context: makeContext() },
			);
		});
		expect(result).toEqual({ success: false, error: "streaming_active" });
		expect(resolved).toBe(0);
	});
});
