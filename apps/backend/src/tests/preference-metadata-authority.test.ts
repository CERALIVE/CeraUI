import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PIPEWIRE_BLUETOOTH_PACKAGE_MARKER } from "../modules/bluetooth/bluetooth-constants.ts";
import {
	defaultBluetoothPreferenceStore,
	initBluetoothPreferenceStore,
	resetBluetoothPreferenceStore,
} from "../modules/bluetooth/bluetooth-preference.ts";
import {
	reconcileBluetoothServices,
	resetBluetoothServiceReconcileForTest,
} from "../modules/bluetooth/bluetooth-services.ts";
import { readDongleMetadata } from "../modules/network/dongle-metadata.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "preference-authority-"));
	initBluetoothPreferenceStore(dir);
	resetBluetoothServiceReconcileForTest();
});
afterEach(() => {
	resetBluetoothPreferenceStore();
	resetBluetoothServiceReconcileForTest();
	rmSync(dir, { recursive: true, force: true });
});

test.each([
	'{"version":1,"enabled":false,"enabled":true}',
	'{"version":1,"enabled":true,"enabled":false}',
	'{"version":1,"enabled":',
	'{"version":1,"enabled":"bad"}',
])(
	"ambiguous Bluetooth preference grants zero service actions: %s",
	async (bytes) => {
		// Given ambiguous persisted activation/stop intent and a real preference store.
		const file = join(dir, "bluetooth.json");
		writeFileSync(file, bytes);
		let effects = 0;
		// When the actual boot reconciler decides whether to apply it.
		const outcome = await reconcileBluetoothServices({
			isRealDevice: async () => true,
			preference: defaultBluetoothPreferenceStore,
			systemctl: async (args) => {
				if (["enable", "disable", "start", "stop"].includes(args[0] ?? ""))
					effects++;
				return {
					exitCode: 0,
					stdout: args[0] === "is-active" ? "active\n" : "enabled\n",
					stderr: "",
				};
			},
			fileExists: async (file) => file === PIPEWIRE_BLUETOOTH_PACKAGE_MARKER,
			readFile: async () => undefined,
			writeDropIn: async () => {
				effects++;
			},
			probeHelp: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			log: () => {},
			warn: () => {},
		});
		// Then neither unit effects nor a positive applied outcome comes from corruption.
		expect(effects).toBe(0);
		expect(outcome.ok).toBe(false);
		expect(readFileSync(file, "utf8")).toBe(bytes);
	},
);

test("genuine absent Bluetooth intent leaves image state untouched", () => {
	// Given no operator preference file.
	// When the real store is read.
	expect(defaultBluetoothPreferenceStore.read()).toBeUndefined();
});

test("contradictory runtime metadata grants zero up dongle projections", async () => {
	// Given a fresh complete record with contradictory physical state.
	const file = join(dir, "dongle0.json");
	const bytes = `${JSON.stringify({
		version: 1,
		slot: 0,
		ifname: "eth1",
		usb_path: "usb:1",
		mac: "aa:bb:cc:dd:ee:ff",
		driver: "cdc_ether",
		inner_ip: null,
		inner_gateway: null,
		veth_host: "dg0h",
		veth_host_ip: "10.208.0.1",
		state: "down",
		updated_at_ms: 1000,
		lease_refresh_ms: 30000,
	}).slice(0, -1)},"state":"up"}`;
	writeFileSync(file, bytes);
	// When the real parser receives file bytes at its existing I/O port.
	const projection = await readDongleMetadata({
		listFiles: async () => [file],
		readFile: async (path) => Bun.file(path).text(),
		now: () => 1000,
	});
	// Then a last-wins state cannot publish an up row/eligibility hint.
	expect(projection.size).toBe(0);
	expect(readFileSync(file, "utf8")).toBe(bytes);
});
