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
	isLiftableSuppression,
	isOfferedTarget,
	resolveUsbModeTarget,
	usbOfferSuppressionBodyKey,
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

	it("re-spells the hyphenated runtime literals into snake_case keys", () => {
		// The wire literals are modem-stack's own and carry hyphens; every message
		// key in this catalog is snake_case. Interpolating the token would resolve
		// to a missing key, which renders as the raw dotted path.
		expect(usbOfferSuppressionKey("unknown-vendor")).toBe(
			"network.modem.usbMode.error.unknown_vendor",
		);
		expect(usbOfferSuppressionKey("no-return-path")).toBe(
			"network.modem.usbMode.error.no_return_path",
		);
		expect(usbOfferSuppressionKey("blocked-by-state")).toBe(
			"network.modem.usbMode.error.blocked_by_state",
		);
	});

	it("gives `provisioning-disabled` the sentence the REFUSAL already has", () => {
		// One machine token, one operator sentence, whichever surface produced it.
		// A runtime-specific twin would let the offer and the dispatch describe the
		// same setting two different ways.
		expect(usbOfferSuppressionKey("provisioning-disabled")).toBe(
			"network.modem.usbMode.error.provisioning_disabled",
		);
	});
});

describe("a liftable condition renders a DISABLED control, not an absent one", () => {
	it.each(["blocked-by-state", "provisioning-disabled"] as const)(
		"%s is `blocked`",
		(reason) => {
			expect(
				deriveUsbModeOffer({
					options: options({ certified: [], suppressed: reason }),
					activeMode: "qmi",
					recommendedMode: undefined,
				}),
			).toEqual({ phase: "blocked", reason });
			expect(isLiftableSuppression(reason)).toBe(true);
		},
	);

	it.each([
		"unknown-vendor",
		"no-return-path",
		"uncertified",
		"identity_unresolved",
		"unavailable_in_emulated_mode",
	] as const)("%s is `withheld` — no control at all", (reason) => {
		// A disabled control claims a capability is being kept back. For these
		// there is none to keep back: this build cannot ask the device, or the
		// device's own answer proves no route home. Rendering them the same way as
		// a lifted-in-one-tap condition is the collapse this split exists to undo.
		expect(
			deriveUsbModeOffer({
				options: options({ certified: [], suppressed: reason }),
				activeMode: "qmi",
				recommendedMode: undefined,
			}),
		).toEqual({ phase: "withheld", reason });
		expect(isLiftableSuppression(reason)).toBe(false);
	});

	it("neither phase can be dispatched from", () => {
		// The MUST-NOT this file guards: no switch is rendered for a device with no
		// proven return path, so no target resolves out of either suppressed phase.
		for (const reason of ["no-return-path", "blocked-by-state"] as const) {
			const offer = deriveUsbModeOffer({
				options: options({ certified: [], suppressed: reason }),
				activeMode: "qmi",
				recommendedMode: "mbim",
			});
			expect(resolveUsbModeTarget(offer, "mbim")).toBeUndefined();
			expect(isOfferedTarget(offer, "mbim")).toBe(false);
		}
	});
});

describe("usbOfferSuppressionBodyKey", () => {
	it("explains the states an operator can act on", () => {
		expect(usbOfferSuppressionBodyKey("unknown-vendor")).toBe(
			"network.modem.usbMode.unknownVendorBody",
		);
		expect(usbOfferSuppressionBodyKey("no-return-path")).toBe(
			"network.modem.usbMode.noReturnPathBody",
		);
		expect(usbOfferSuppressionBodyKey("blocked-by-state")).toBe(
			"network.modem.usbMode.blockedByStateBody",
		);
		expect(usbOfferSuppressionBodyKey("provisioning-disabled")).toBe(
			"network.modem.usbMode.provisioningBody",
		);
	});

	it("stays silent where the head sentence is already the whole answer", () => {
		// `identity_unresolved` names its own remedy and an emulated host has no
		// operator action at all, so a second line there would be filler.
		expect(usbOfferSuppressionBodyKey("identity_unresolved")).toBeUndefined();
		expect(
			usbOfferSuppressionBodyKey("unavailable_in_emulated_mode"),
		).toBeUndefined();
	});
});
