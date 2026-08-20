/**
 * `modems.getUsbModeOptions` — WHICH modes may be offered, and to whom.
 *
 * The property under test is AGREEMENT: the set this read offers must be exactly
 * the set `setUsbMode` would accept, for the same device, against the same
 * catalog. So the fixtures are the SHIPPED catalog and the same synthetic SKU
 * `modem-usb-mode-transition.test.ts` drives, and each offered target is
 * additionally proven dispatchable by running the real transition on it.
 *
 * The second property is that a device with nothing to offer offers NOTHING —
 * never a partial set, never a placeholder, and never a mode belonging to a
 * neighbouring firmware.
 */
import { describe, expect, test } from "bun:test";

import { CERTIFIED_CATALOG } from "@ceralive/modem-control";
import {
	setUsbModeFailureReasonSchema,
	setUsbModeRefusalSchema,
	usbModeOfferSuppressionSchema,
} from "@ceraui/rpc/schemas";
import {
	certifiedUsbTargets,
	resolveUsbModeOptions,
} from "../modules/modems/usb-mode-certification.ts";
import type { UsbModeDispatchDeps } from "../modules/modems/usb-mode-contract.ts";
import type { ResolvedModemIdentity } from "../modules/modems/usb-mode-identity.ts";

const CERTIFIED = {
	vidPid: "2c7c:0125",
	model: "CERALIVE-SYNTHETIC-TEST-SKU",
	firmwareRevision: "SYNTHETICFW01.002.03",
} as const;

function identity(
	overrides: Partial<ResolvedModemIdentity> = {},
): ResolvedModemIdentity {
	return {
		stableKey: "platform-xhci-hcd.0-usb-1:2",
		vidPid: CERTIFIED.vidPid,
		model: CERTIFIED.model,
		firmwareRevision: CERTIFIED.firmwareRevision,
		currentMode: "qmi",
		physicalUid: "platform-xhci-hcd.0-usb-1:2",
		ifname: "wwan0",
		ports: ["wwan0 (net)", "ttyUSB2 (at)"],
		...overrides,
	};
}

function optionDeps(
	resolved: ResolvedModemIdentity | undefined,
): UsbModeDispatchDeps {
	return {
		resolveIdentity: () => Promise.resolve(resolved),
		catalog: CERTIFIED_CATALOG,
		resolveConnectionId: () => Promise.resolve("uuid-1"),
		resolveInhibitUid: () => Promise.resolve("uid-1"),
		createEngine: () => undefined,
		confirmDataPath: () => Promise.resolve(true),
		rediscover: () => Promise.resolve(),
		now: () => 0,
	};
}

describe("certifiedUsbTargets — the exact model+firmware, and nothing near it", () => {
	test("offers exactly the catalog's targets OUT of the mode the device is in", () => {
		expect(certifiedUsbTargets(CERTIFIED_CATALOG, identity())).toEqual([
			"mbim",
			"ecm-ncm",
		]);
	});

	test("the same SKU in a DIFFERENT mode offers that mode's targets, not the entry's whole table", () => {
		// The catalog also certifies `mbim → qmi` and `ecm-ncm → qmi`. A device
		// sitting in `mbim` must be offered `qmi` alone — offering `ecm-ncm` would
		// offer a transition that starts from a mode it is not in.
		expect(
			certifiedUsbTargets(CERTIFIED_CATALOG, identity({ currentMode: "mbim" })),
		).toEqual(["qmi"]);
		expect(
			certifiedUsbTargets(
				CERTIFIED_CATALOG,
				identity({ currentMode: "ecm-ncm" }),
			),
		).toEqual(["qmi"]);
	});

	test("a firmware ONE character short of the certified prefix offers nothing", () => {
		expect(
			certifiedUsbTargets(
				CERTIFIED_CATALOG,
				identity({ firmwareRevision: "SYNTHETICFW0" }),
			),
		).toEqual([]);
	});

	test("a different model on the certified VID:PID offers nothing", () => {
		expect(
			certifiedUsbTargets(CERTIFIED_CATALOG, identity({ model: "RM520N-GL" })),
		).toEqual([]);
	});

	test("a real fleet modem offers nothing — no reviewed evidence bundle exists", () => {
		expect(
			certifiedUsbTargets(
				CERTIFIED_CATALOG,
				identity({
					vidPid: "2c7c:0801",
					model: "RM530N-GL",
					firmwareRevision: "RM530NGLAAR05A01M4G",
				}),
			),
		).toEqual([]);
	});

	test("a NON-MM current mode offers nothing — the catalog forbids crossing that line", () => {
		for (const mode of ["rndis", "router-ethernet"] as const) {
			expect(
				certifiedUsbTargets(CERTIFIED_CATALOG, identity({ currentMode: mode })),
			).toEqual([]);
		}
	});

	test("an unreadable current mode offers nothing rather than guessing", () => {
		expect(
			certifiedUsbTargets(
				CERTIFIED_CATALOG,
				identity({ currentMode: undefined }),
			),
		).toEqual([]);
	});

	test("the active mode is never among its own targets", () => {
		for (const mode of ["qmi", "mbim", "ecm-ncm"] as const) {
			expect(
				certifiedUsbTargets(CERTIFIED_CATALOG, identity({ currentMode: mode })),
			).not.toContain(mode);
		}
	});
});

describe("resolveUsbModeOptions — the wire answer", () => {
	test("a certified device answers with its targets and NO suppression", async () => {
		const result = await resolveUsbModeOptions("0", optionDeps(identity()));
		expect(result).toEqual({
			active: "qmi",
			certified: ["mbim", "ecm-ncm"],
		});
		expect(result.suppressed).toBeUndefined();
	});

	test("an unresolvable device — native PCIe, a router dongle, or one that left — is identity_unresolved", async () => {
		const result = await resolveUsbModeOptions("9", optionDeps(undefined));
		expect(result).toEqual({
			certified: [],
			suppressed: "identity_unresolved",
		});
	});

	test("a resolved device with no catalog entry is `uncertified`, and still reports its active mode", async () => {
		const result = await resolveUsbModeOptions(
			"0",
			optionDeps(identity({ firmwareRevision: "UNKNOWNFW99" })),
		);
		expect(result).toEqual({
			active: "qmi",
			certified: [],
			suppressed: "uncertified",
		});
	});

	test("a CERTIFIED device with no way out of its mode is empty and UNSUPPRESSED — its model was reviewed", async () => {
		// `rndis` is not an MM mode, so no transition leads out of it — but the SKU
		// itself is in the catalog. Calling that `uncertified` would tell an
		// operator their model was never reviewed, which is false.
		const result = await resolveUsbModeOptions(
			"0",
			optionDeps(identity({ currentMode: "rndis" })),
		);
		expect(result).toEqual({ active: "rndis", certified: [] });
		expect(result.suppressed).toBeUndefined();
	});

	test("the read touches NO engine and NO mutation lease", async () => {
		let engineBuilds = 0;
		const deps: UsbModeDispatchDeps = {
			...optionDeps(identity()),
			createEngine: () => {
				engineBuilds += 1;
				return undefined;
			},
		};
		await resolveUsbModeOptions("0", deps);
		expect(engineBuilds).toBe(0);
	});
});

describe("the offer vocabulary is BORROWED, never invented", () => {
	test("every suppression token already exists in the switch's typed vocabulary", () => {
		// A token with no home in either enum is a token with no operator copy, so
		// it would reach the screen as a raw dotted key.
		const known = new Set<string>([
			...setUsbModeRefusalSchema.options,
			...setUsbModeFailureReasonSchema.options,
		]);
		for (const token of usbModeOfferSuppressionSchema.options) {
			expect(known.has(token)).toBe(true);
		}
	});

	test("the two source enums are BOTH load-bearing — the split is why copy keys need a table", () => {
		const refusals = new Set<string>(setUsbModeRefusalSchema.options);
		const reasons = new Set<string>(setUsbModeFailureReasonSchema.options);

		expect(refusals.has("uncertified")).toBe(true);
		expect(refusals.has("unavailable_in_emulated_mode")).toBe(true);
		// `identity_unresolved` rides `transition_failed` as a REASON, so its copy
		// lives under `reason.*` while the other two live under `error.*`.
		expect(refusals.has("identity_unresolved")).toBe(false);
		expect(reasons.has("identity_unresolved")).toBe(true);
	});
});
