import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createUsbEnumerator } from "@ceralive/modem-control";
import {
	refreshModemUsbModes,
	resetModemUsbModes,
} from "../modules/modems/modem-usb-mode-source.ts";
import {
	defaultMutationBlockDeps,
	PRESENCE_UNKNOWN,
} from "../modules/modems/mutation-blocks.ts";

afterEach(() => {
	resetModemUsbModes();
	mock.restore();
});

test("default modem enumeration never reads host devices, including after reader reset", async () => {
	// Given: no test owns a host command or a USB fixture.
	const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
		throw new Error("unexpected host enumeration");
	});
	resetModemUsbModes();

	// When: both implicit CeraUI readers and the package factory enumerate.
	await refreshModemUsbModes();
	const present = await defaultMutationBlockDeps.presentStableKeys();
	const devices = await createUsbEnumerator().enumerate();
	const explicitDefaults = await createUsbEnumerator({}).enumerate();

	// Then: an empty fixture, not host identity or an unreadable-bus sentinel.
	expect(present).toEqual(new Set());
	expect(present).not.toBe(PRESENCE_UNKNOWN);
	expect(devices).toEqual([]);
	expect(explicitDefaults).toEqual([]);
	expect(spawn).not.toHaveBeenCalled();
});

test("an explicit USB database reader retains the real enumerator parser", async () => {
	// Given: an identity deliberately different from an empty host fixture.
	const database = [
		"P: /devices/test-usb/1-1",
		"E: DEVTYPE=usb_device",
		"E: ID_VENDOR_ID=2c7c",
		"E: ID_MODEL_ID=0800",
		"E: ID_PATH=platform-test-usb-0:1",
		"E: ID_USB_INTERFACES=:ff0000:",
	].join("\n");
	const reader = mock(async () => database);
	const spawn = spyOn(Bun, "spawn");

	// When: the caller opts into fixture-owned input through the published seam.
	const devices = await createUsbEnumerator({
		readUdevDatabase: reader,
	}).enumerate();

	// Then: the parser keeps the supplied identity, rather than substituting [].
	expect(devices).toHaveLength(1);
	expect(devices[0]?.physicalUid).toBe("platform-test-usb-0:1");
	expect(devices[0]?.vendorId).toBe("2c7c");
	expect(reader).toHaveBeenCalledTimes(1);
	expect(spawn).not.toHaveBeenCalled();
});
