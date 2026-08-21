/**
 * The USB-mode OFFER rule — which modes may be rendered at all.
 *
 * The property under test is that the rendered set is the DEVICE's certified
 * set and nothing else. Two ways that gets broken in practice are pinned
 * directly: `recommended_usb_mode` leaking back in as a target on its own, and
 * "we could not establish the set" being rendered as "the set is empty".
 */

import type { UsbModeOptionsOutput } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	deriveUsbModeOffer,
	isOfferedTarget,
	resolveUsbModeTarget,
	usbOfferSuppressionKey,
} from "$lib/rpc/usb-mode-offer";

const options = (
	overrides: Partial<UsbModeOptionsOutput> = {},
): UsbModeOptionsOutput => ({ certified: ["mbim", "ecm-ncm"], ...overrides });

describe("deriveUsbModeOffer", () => {
	it("offers exactly the certified set", () => {
		const offer = deriveUsbModeOffer({
			options: options(),
			activeMode: "qmi",
			recommendedMode: "mbim",
		});
		expect(offer).toEqual({
			phase: "offered",
			targets: ["mbim", "ecm-ncm"],
			preferred: "mbim",
		});
	});

	it("NEVER asked is not the same as certified-for-nothing", () => {
		// An in-flight or failed read must render no control AND no explanation —
		// rendering "uncertified" here would state a device fact we do not have.
		expect(
			deriveUsbModeOffer({
				options: undefined,
				activeMode: "qmi",
				recommendedMode: "mbim",
			}),
		).toEqual({ phase: "unknown" });
	});

	it("a recommended mode that is NOT certified is never offered", () => {
		// The whole defect this rule replaces: `recommended_usb_mode` is a
		// stability advisory and carries no certification claim, so it may only
		// ever PREFER among certified targets — never introduce one.
		const offer = deriveUsbModeOffer({
			options: options({ certified: ["ecm-ncm"] }),
			activeMode: "qmi",
			recommendedMode: "mbim",
		});
		expect(offer).toEqual({
			phase: "offered",
			targets: ["ecm-ncm"],
			preferred: "ecm-ncm",
		});
	});

	it("falls back to the first certified target when nothing is recommended", () => {
		const offer = deriveUsbModeOffer({
			options: options(),
			activeMode: "qmi",
			recommendedMode: undefined,
		});
		expect(offer).toMatchObject({ phase: "offered", preferred: "mbim" });
	});

	it("never offers the mode the device is already in", () => {
		const offer = deriveUsbModeOffer({
			options: options({ certified: ["qmi", "mbim"] }),
			activeMode: "qmi",
			recommendedMode: "qmi",
		});
		expect(offer).toEqual({
			phase: "offered",
			targets: ["mbim"],
			preferred: "mbim",
		});
	});

	it("a certified device with no way out is SETTLED — no control, no complaint", () => {
		expect(
			deriveUsbModeOffer({
				options: options({ certified: [] }),
				activeMode: "qmi",
				recommendedMode: "mbim",
			}),
		).toEqual({ phase: "settled" });
	});

	it.each([
		"identity_unresolved",
		"uncertified",
		"unavailable_in_emulated_mode",
	] as const)("withholds the offer verbatim on %s", (reason) => {
		expect(
			deriveUsbModeOffer({
				options: options({ certified: [], suppressed: reason }),
				activeMode: "qmi",
				recommendedMode: "mbim",
			}),
		).toEqual({ phase: "withheld", reason });
	});

	it("a suppression outranks any modes that rode along with it", () => {
		expect(
			deriveUsbModeOffer({
				options: options({ certified: ["mbim"], suppressed: "uncertified" }),
				activeMode: "qmi",
				recommendedMode: "mbim",
			}),
		).toEqual({ phase: "withheld", reason: "uncertified" });
	});
});

describe("resolveUsbModeTarget", () => {
	const offer = deriveUsbModeOffer({
		options: options(),
		activeMode: "qmi",
		recommendedMode: "mbim",
	});

	it("dispatches the operator's own pick", () => {
		expect(resolveUsbModeTarget(offer, "ecm-ncm")).toBe("ecm-ncm");
	});

	it("falls back to the preference when nothing is picked", () => {
		expect(resolveUsbModeTarget(offer, undefined)).toBe("mbim");
	});

	it("refuses a pick the device no longer offers", () => {
		// The certified set is re-read on every open and hardware can change
		// between them; a stale pick must not be dispatched.
		expect(resolveUsbModeTarget(offer, "rndis")).toBe("mbim");
		expect(isOfferedTarget(offer, "rndis")).toBe(false);
	});

	it("has NO target at all unless a set is being offered", () => {
		for (const phase of [
			{ phase: "unknown" } as const,
			{ phase: "settled" } as const,
			{ phase: "withheld", reason: "uncertified" } as const,
		]) {
			expect(resolveUsbModeTarget(phase, "mbim")).toBeUndefined();
		}
	});
});

describe("usbOfferSuppressionKey", () => {
	it("resolves each token into a key that EXISTS", () => {
		// The two tokens live in different namespaces, so an interpolated key
		// would render as a raw dotted path for one of them.
		expect(usbOfferSuppressionKey("identity_unresolved")).toBe(
			"network.modem.usbMode.reason.identity_unresolved",
		);
		expect(usbOfferSuppressionKey("uncertified")).toBe(
			"network.modem.usbMode.error.uncertified",
		);
		expect(usbOfferSuppressionKey("unavailable_in_emulated_mode")).toBe(
			"network.modem.usbMode.error.unavailable_in_emulated_mode",
		);
	});
});
