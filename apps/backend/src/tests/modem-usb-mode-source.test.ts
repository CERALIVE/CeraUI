/**
 * The wire's `usb_mode`, and where it comes from on a real board.
 *
 * Before `modem-usb-mode-source.ts` the field was written by exactly one caller
 * in the whole backend — `mocks/providers/cellular.ts`. ModemManager does not
 * report a USB composition, so the D-Bus fold could not produce one, and the
 * frontend's USB-mode card (which renders only when an active or recommended
 * mode is known) was therefore unreachable on hardware regardless of what the
 * certified catalog said. These tests pin the real source, and the precedence
 * that keeps an observed value winning over the udev read.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
	modemUsbModeForStableKey,
	refreshModemUsbModes,
	resetModemUsbModes,
	setModemUsbModeReaderForTest,
} from "../modules/modems/modem-usb-mode-source.ts";

const QUECTEL_KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.4";

afterEach(() => {
	resetModemUsbModes();
});

describe("the USB composition a row advertises", () => {
	test("is unknown before anything has been read", () => {
		expect(modemUsbModeForStableKey(QUECTEL_KEY)).toBeUndefined();
	});

	test("is published per stable key after a refresh", async () => {
		setModemUsbModeReaderForTest(() =>
			Promise.resolve(new Map([[QUECTEL_KEY, "qmi" as const]])),
		);
		await refreshModemUsbModes();

		expect(modemUsbModeForStableKey(QUECTEL_KEY)).toBe("qmi");
	});

	test("follows the device across a composition change", async () => {
		setModemUsbModeReaderForTest(() =>
			Promise.resolve(new Map([[QUECTEL_KEY, "qmi" as const]])),
		);
		await refreshModemUsbModes();
		setModemUsbModeReaderForTest(() =>
			Promise.resolve(new Map([[QUECTEL_KEY, "mbim" as const]])),
		);
		await refreshModemUsbModes();

		expect(modemUsbModeForStableKey(QUECTEL_KEY)).toBe("mbim");
	});

	test("a FAILED read retains the previous map — the card is not withdrawn", async () => {
		setModemUsbModeReaderForTest(() =>
			Promise.resolve(new Map([[QUECTEL_KEY, "mbim" as const]])),
		);
		await refreshModemUsbModes();
		setModemUsbModeReaderForTest(() =>
			Promise.reject(new Error("udev is down")),
		);
		await refreshModemUsbModes();

		expect(modemUsbModeForStableKey(QUECTEL_KEY)).toBe("mbim");
	});

	test("an unknown key, an empty key and undefined all answer undefined", async () => {
		setModemUsbModeReaderForTest(() =>
			Promise.resolve(new Map([[QUECTEL_KEY, "qmi" as const]])),
		);
		await refreshModemUsbModes();

		expect(
			modemUsbModeForStableKey("platform-other-usb-0:9.9"),
		).toBeUndefined();
		expect(modemUsbModeForStableKey("")).toBeUndefined();
		expect(modemUsbModeForStableKey(undefined)).toBeUndefined();
	});
});
