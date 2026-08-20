/**
 * The capability-mutation identity resolver, against the board's REAL udev.
 *
 * This is the second half of the defect `modem-id-path-source.ts` documents. That
 * module repaired the WIRE PRODUCER's `stable_key` map by reading udev's NET
 * records; `defaultResolveIdentity` — the resolver every capability module and
 * the USB-mode switch call FIRST — was left matching
 * `createUsbEnumerator().enumerate()` on `d.ifname`, a field that module already
 * proved is never populated. So `stable_key` was correct on the wire while every
 * capability RPC answered `unknown_modem` on the same board, in the same second.
 *
 * Every fixture here is VERBATIM `udevadm info --export-db` output from bench
 * `ceralive2` (Quectel RM530N-GL, 2026-08-18). That is the whole point: the
 * retired code passed its suite because its fixtures were hand-built snapshots
 * carrying an `ifname` udev does not put there.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deriveModemStableKey } from "@ceraui/rpc/schemas";
import { parseNetIdPaths } from "../modules/modems/modem-id-path-source.ts";
import {
	refreshModemIdPaths,
	resetModemWireProducer,
	setModemIdPathReader,
} from "../modules/modems/modem-wire-producer.ts";
import { removeModem, setModem } from "../modules/modems/modems-state.ts";
import { resolveModemIdentityAnchor } from "../modules/modems/mutation-identity.ts";
import {
	defaultResolveIdentity,
	setModemGenericFactsReaderForTest,
	setUsbUdevDatabaseReaderForTest,
} from "../modules/modems/usb-mode-identity.ts";

/** The Quectel's `usb_device` record — note it carries NO `INTERFACE`. */
const USB_DEVICE_RECORD = `P: /devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4/4-1.4.4
M: 4-1.4.4
T: usb_device
E: DEVPATH=/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4/4-1.4.4
E: SUBSYSTEM=usb
E: DEVTYPE=usb_device
E: DRIVER=usb
E: PRODUCT=2c7c/801/504
E: BUSNUM=004
E: DEVNUM=009
E: ID_BUS=usb
E: ID_MODEL=RM530N-GL
E: ID_MODEL_ID=0801
E: ID_SERIAL_SHORT=a71aca62
E: ID_VENDOR=Quectel
E: ID_VENDOR_ID=2c7c
E: ID_REVISION=0504
E: ID_USB_INTERFACES=:ffff30:ff0040:ff0000:ffffff:
E: ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.4.4
E: ID_PATH_TAG=platform-xhci-hcd_0_auto-usb-0_1_4_4`;

/** …and its netdev — a SEPARATE record, the only one naming the interface. */
const NET_RECORD = `P: /devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4/4-1.4.4/4-1.4.4:1.4/net/wwan2
M: wwan2
U: net
T: wwan
E: DEVPATH=/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4/4-1.4.4/4-1.4.4:1.4/net/wwan2
E: SUBSYSTEM=net
E: DEVTYPE=wwan
E: INTERFACE=wwan2
E: IFINDEX=79
E: ID_BUS=usb
E: ID_MODEL=RM530N-GL
E: ID_MODEL_ID=0801
E: ID_VENDOR_ID=2c7c
E: ID_REVISION=0504
E: ID_USB_DRIVER=qmi_wwan
E: ID_MM_CANDIDATE=1
E: ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.4.4:1.4
E: ID_PATH_TAG=platform-xhci-hcd_0_auto-usb-0_1_4_4_1_4
E: ID_NET_DRIVER=qmi_wwan
E: ID_NET_NAME=wwan2`;

const EXPORT_DB = `${USB_DEVICE_RECORD}\n\n${NET_RECORD}\n\n`;

/**
 * Verbatim `mmcli -K -m 9` values for the SAME unit, 2026-08-19. Note the
 * revision: udev's `ID_REVISION` above says `0504` for this modem — that is the
 * USB `bcdDevice`, and every firmware build of an RM530N-GL reports it.
 */
const MM_FACTS = {
	ports: [
		"cdc-wdm2 (qmi)",
		"ttyUSB5 (ignored)",
		"ttyUSB6 (gps)",
		"ttyUSB7 (at)",
		"ttyUSB8 (at)",
		"wwan2 (net)",
	],
	revision: "RM530NGLAAR05A01M4G",
};

const IFNAME = "wwan2";
const DEVICE_ID = "5";
const MODEM_INDEX = 5;
/** The `usb_device` parent's own ID_PATH — what both sides must reduce to. */
const STABLE_KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.4";

function seedModem(): void {
	setModem(MODEM_INDEX, {
		ifname: IFNAME,
		name: "Quectel RM530N-GL",
		sim_network: "",
		network_type: { supported: {}, active: "5g" },
		status: {
			connection: "connected",
			network: "Movistar",
			network_type: "5G",
			signal: 72,
			roaming: false,
		},
		config: {
			autoconfig: false,
			apn: "internet",
			username: "",
			password: "",
			roaming: false,
			network: "",
		},
	});
}

describe("the modem identity every capability module resolves through", () => {
	beforeEach(async () => {
		resetModemWireProducer();
		seedModem();
		setModemIdPathReader(() => Promise.resolve(parseNetIdPaths(EXPORT_DB)));
		await refreshModemIdPaths();
		setUsbUdevDatabaseReaderForTest(() => Promise.resolve(EXPORT_DB));
		setModemGenericFactsReaderForTest(() => Promise.resolve(MM_FACTS));
	});

	afterEach(() => {
		setUsbUdevDatabaseReaderForTest(null);
		setModemGenericFactsReaderForTest(null);
		resetModemWireProducer();
		removeModem(MODEM_INDEX);
	});

	test("the board's usb_device record carries no INTERFACE — the retired match's whole input", () => {
		expect(USB_DEVICE_RECORD).toContain("DEVTYPE=usb_device");
		expect(USB_DEVICE_RECORD).not.toContain("INTERFACE=");
		// The netdev is where the name lives, and it is a different record.
		expect(NET_RECORD).toContain("INTERFACE=wwan2");
	});

	test("the capability resolver answers the stable key the wire publishes", async () => {
		await expect(resolveModemIdentityAnchor(DEVICE_ID)).resolves.toEqual({
			stableKey: STABLE_KEY,
		});
	});

	test("…and by the MM object path the SIM procedures are handed too", async () => {
		await expect(
			resolveModemIdentityAnchor(
				`/org/freedesktop/ModemManager1/Modem/${MODEM_INDEX}`,
			),
		).resolves.toEqual({ stableKey: STABLE_KEY });
	});

	test("an unknown modem still resolves to nothing", async () => {
		await expect(resolveModemIdentityAnchor("41")).resolves.toBeUndefined();
	});

	test("a modem whose netdev publishes no ID_PATH is refused, never keyed on its name", async () => {
		setModemIdPathReader(() => Promise.resolve(new Map()));
		await refreshModemIdPaths();
		await expect(
			resolveModemIdentityAnchor(DEVICE_ID),
		).resolves.toBeUndefined();
	});

	test("the full identity matches the USB device by STABLE KEY, not by ifname", async () => {
		const identity = await defaultResolveIdentity(DEVICE_ID);
		expect(identity).toBeDefined();
		expect(identity?.stableKey).toBe(STABLE_KEY);
		// The catalog discriminators are why the enumerator is still consulted.
		expect(identity?.vidPid).toBe("2c7c:0801");
		expect(identity?.model).toBe("RM530N-GL");
		expect(identity?.ifname).toBe(IFNAME);
	});

	test("the firmware revision is ModemManager's, NOT udev's USB bcdDevice", async () => {
		const identity = await defaultResolveIdentity(DEVICE_ID);
		expect(identity?.firmwareRevision).toBe("RM530NGLAAR05A01M4G");
		// The value the retired source would have produced, from a record still present.
		expect(EXPORT_DB).toContain("ID_REVISION=0504");
		expect(identity?.firmwareRevision).not.toBe("0504");
	});

	test("the ports come from the SAME single read as the revision", async () => {
		const identity = await defaultResolveIdentity(DEVICE_ID);
		expect(identity?.ports).toEqual(MM_FACTS.ports);
	});

	test("an unreadable ModemManager yields an EMPTY revision — uncertified, never mis-keyed", async () => {
		setModemGenericFactsReaderForTest(() => Promise.resolve(undefined));
		const identity = await defaultResolveIdentity(DEVICE_ID);
		expect(identity).toBeDefined();
		expect(identity?.firmwareRevision).toBe("");
		expect(identity?.ports).toEqual([]);
	});

	test("the two udev records reduce to ONE key, which is why they can be matched", () => {
		const fromNet = parseNetIdPaths(EXPORT_DB).get(IFNAME);
		expect(fromNet).toBe("platform-xhci-hcd.0.auto-usb-0:1.4.4:1.4");
		expect(deriveModemStableKey(fromNet)).toBe(STABLE_KEY);
		expect(deriveModemStableKey(STABLE_KEY)).toBe(STABLE_KEY);
	});

	test("a USB device that does not share the key is NOT adopted", async () => {
		const foreign = USB_DEVICE_RECORD.replaceAll("1.4.4", "1.4.7");
		setUsbUdevDatabaseReaderForTest(() =>
			Promise.resolve(`${foreign}\n\n${NET_RECORD}\n\n`),
		);
		await expect(defaultResolveIdentity(DEVICE_ID)).resolves.toBeUndefined();
	});
});
