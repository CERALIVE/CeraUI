/**
 * BLOCKER B7 — `setUsbMode` refused a device `getUsbModeOptions` had just resolved.
 *
 * The divergence was never the identity resolver: both paths run the SAME
 * `deps.resolveIdentity`. It was the transition's TWO NetworkManager reads, which
 * asked NM about the modem's NETDEV — a name NM does not know for an MM-managed
 * modem — and reported the miss as `identity_unresolved`.
 *
 * The fixtures are the verbatim `ceralive2` topology (Quectel RM530N-GL,
 * 2026-08-19): `wwan2` is absent from `nmcli device status`, and the modem is the
 * `gsm` device `cdc-wdm2` whose `GENERAL.IP-IFACE` IS `wwan2`. The existing
 * transition suite stubs both NM reads, which is exactly why it stayed green while
 * the board did not — so every case here drives the PRODUCTION
 * `defaultResolveConnectionId` / `confirmModemDataPath`.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	CertifiedCatalog,
	UsbModeTransitionOutcome,
	UsbModeTransitionRequest,
} from "@ceralive/modem-control";

import {
	type ModemNmDeviceReader,
	resolveModemNmDevice,
	resolveModemNmDeviceForConnection,
	setModemNmDeviceReaderForTest,
} from "../modules/modems/modem-nm-device.ts";
import {
	defaultMutationJournalFs,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { resolveUsbModeOptions } from "../modules/modems/usb-mode-certification.ts";
import type { UsbModeDispatchDeps } from "../modules/modems/usb-mode-contract.ts";
import {
	confirmModemDataPath,
	defaultResolveConnectionId,
	type ResolvedModemIdentity,
} from "../modules/modems/usb-mode-identity.ts";
import { runUsbModeTransition } from "../modules/modems/usb-mode-transition.ts";
import { resetLifecycleInterlock } from "../modules/streaming/lifecycle-admission.ts";

const IFNAME = "wwan2";
const NM_DEVICE = "cdc-wdm2";
const CON_UUID = "6832198b-4c31-425a-8251-45a3dd55df0c";

const BOARD_NM_DEVICES: readonly string[] = [
	"eth0:ethernet",
	"enx020a53313630:ethernet",
	"enx0c5b8f279a64:ethernet",
	"eth1:ethernet",
	"lo:loopback",
	"wlan0:wifi",
	"cdc-wdm2:gsm",
	"cdc-wdm1:gsm",
	"ttyUSB12:gsm",
	"p2p-dev-wlan0:wifi-p2p",
	"cdc-wdm0:gsm",
];

const BOARD_PROPS: Readonly<Record<string, Readonly<Record<string, string>>>> =
	{
		"cdc-wdm2": {
			"GENERAL.IP-IFACE": IFNAME,
			"GENERAL.CON-UUID": CON_UUID,
			"GENERAL.CON-UUID,GENERAL.AVAILABLE-CONNECTIONS": `${CON_UUID} | Movistar`,
			"GENERAL.STATE": "100 (connected)",
			"IP4.ADDRESS": "10.151.220.76/29",
		},
		"cdc-wdm1": { "GENERAL.IP-IFACE": "" },
		"cdc-wdm0": { "GENERAL.IP-IFACE": "" },
		ttyUSB12: { "GENERAL.IP-IFACE": "" },
		eth0: { "GENERAL.IP-IFACE": "eth0" },
	};

function boardNm(): { probed: string[] } {
	const probed: string[] = [];
	const reader: ModemNmDeviceReader = {
		listDevices: () => Promise.resolve(BOARD_NM_DEVICES),
		deviceProp: (device, fields) => {
			probed.push(device);
			return Promise.resolve([BOARD_PROPS[device]?.[fields] ?? ""]);
		},
	};
	setModemNmDeviceReaderForTest(reader);
	return { probed };
}

const CATALOG = {
	version: 1,
	entries: [
		{
			vidPid: "2c7c:0801",
			model: "RM530N-GL",
			firmwarePrefix: "RM530NGLAAR05A01M4G",
			canonicalMode: "qmi",
			permittedTransitions: [
				{
					from: "qmi",
					to: "mbim",
					atCommand: 'AT+QCFG="usbnet",2',
					expectedResponse: "OK",
					expectsPortDrop: true,
					expectedDescriptors: {
						deviceClass: 0,
						interfaces: [
							{
								interfaceClass: 2,
								interfaceSubClass: 14,
								interfaceProtocol: 0,
							},
						],
					},
				},
			],
		},
	],
} as unknown as CertifiedCatalog;

const IDENTITY: ResolvedModemIdentity = {
	stableKey: "platform-xhci-hcd.0.auto-usb-0:1.4.4",
	vidPid: "2c7c:0801",
	model: "RM530N-GL",
	firmwareRevision: "RM530NGLAAR05A01M4G",
	currentMode: "qmi",
	physicalUid: "platform-xhci-hcd.0.auto-usb-0:1.4.4",
	ifname: IFNAME,
	ports: ["cdc-wdm2 (qmi)", "ttyUSB7 (at)", "wwan2 (net)"],
};

const SUCCEEDED: UsbModeTransitionOutcome = {
	status: "succeeded",
	newIfname: IFNAME as UsbModeTransitionRequest["deviceIfname"],
	steps: [],
};

function dispatch(): {
	deps: UsbModeDispatchDeps;
	seen: { connectionIds: string[] };
} {
	const seen = { connectionIds: [] as string[] };
	return {
		seen,
		deps: {
			resolveIdentity: () => Promise.resolve(IDENTITY),
			catalog: CATALOG,
			// The two members B7 lived in are left at their PRODUCTION
			// implementations — stubbing them is what hid the defect.
			resolveConnectionId: defaultResolveConnectionId,
			confirmDataPath: (ifname) => confirmModemDataPath(ifname),
			resolveInhibitUid: (id) => Promise.resolve(id.physicalUid),
			createEngine: () => ({
				execute: (request: UsbModeTransitionRequest) => {
					seen.connectionIds.push(String(request.connectionId));
					return Promise.resolve(SUCCEEDED);
				},
			}),
			rediscover: () => Promise.resolve(),
			now: () => 1_700_000_000_000,
		},
	};
}

let journalDir: string | undefined;

async function useTempJournal(): Promise<void> {
	journalDir = await mkdtemp(join(tmpdir(), "b7-journal-"));
	setMutationJournalDeps({ dir: journalDir, fs: defaultMutationJournalFs });
}

afterEach(async () => {
	setModemNmDeviceReaderForTest(null);
	resetMutationJournalDeps();
	resetLifecycleInterlock();
	if (journalDir !== undefined) {
		await rm(journalDir, { recursive: true, force: true });
		journalDir = undefined;
	}
});

describe("B7 — one NM-device resolution for both call sites", () => {
	test("the modem's netdev resolves to the gsm device that carries it", async () => {
		// Given: the board's own NM topology, where `wwan2` is not an NM device.
		const { probed } = boardNm();

		// When / Then: it resolves to the device whose IP-IFACE it is.
		await expect(resolveModemNmDevice(IFNAME)).resolves.toBe(NM_DEVICE);
		// Only modem-class devices are probed — never the four ethernet rows.
		expect(probed).not.toContain("eth0");
		expect(probed).not.toContain("eth1");
	});

	test("the saved connection resolves the new modem device before activation", async () => {
		boardNm();
		await expect(resolveModemNmDeviceForConnection(CON_UUID)).resolves.toBe(
			NM_DEVICE,
		);
		await expect(
			resolveModemNmDeviceForConnection("00000000-0000-0000-0000-000000000000"),
		).resolves.toBeUndefined();
	});

	test("a netdev NM manages under its own name resolves to itself", async () => {
		boardNm();
		await expect(resolveModemNmDevice("eth0")).resolves.toBe("eth0");
	});

	test("a netdev no NM device carries stays unresolved", async () => {
		boardNm();
		await expect(resolveModemNmDevice("wwan9")).resolves.toBeUndefined();
	});

	test("the data-path confirmation reads that device, not the netdev", async () => {
		// Given: only `cdc-wdm2` reports a connected state and an address.
		boardNm();

		// When / Then: the poll finds them through the shared resolution.
		await expect(confirmModemDataPath(IFNAME)).resolves.toBe(true);
	});

	test("BOTH call sites answer for the SAME device, and neither refuses", async () => {
		// Given: the board topology and the drilled modem's identity.
		boardNm();
		await useTempJournal();
		const { deps, seen } = dispatch();

		// When: the read path is asked, then the mutation path, for one device.
		const options = await resolveUsbModeOptions("18", deps);
		const applied = await runUsbModeTransition("18", "mbim", deps);

		// Then: the read path offers the certified target …
		expect(options).toEqual({ active: "qmi", certified: ["mbim"] });
		// … and the mutation path reaches the engine with that device's own
		// connection instead of answering `identity_unresolved`.
		expect(applied).toEqual({ success: true });
		expect(seen.connectionIds).toEqual([CON_UUID]);
	});

	test("with no NM device for the netdev, the read path still resolves and the mutation path refuses", async () => {
		// Given: the pre-fix shape — nothing in NM carries the modem's netdev.
		setModemNmDeviceReaderForTest({
			listDevices: () => Promise.resolve(["eth0:ethernet"]),
			deviceProp: () => Promise.resolve([""]),
		});
		await useTempJournal();
		const { deps } = dispatch();

		// When / Then: the divergence is reproduced, which is what B7 reported.
		await expect(resolveUsbModeOptions("18", deps)).resolves.toEqual({
			active: "qmi",
			certified: ["mbim"],
		});
		await expect(runUsbModeTransition("18", "mbim", deps)).resolves.toEqual({
			success: false,
			error: "transition_failed",
			reason: "identity_unresolved",
		});
	});
});
