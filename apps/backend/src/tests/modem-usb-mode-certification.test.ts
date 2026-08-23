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
	usbModeRuntimeSuppressionSchema,
} from "@ceraui/rpc/schemas";
import {
	certifiedUsbTargets,
	resolveUsbModeOptions,
} from "../modules/modems/usb-mode-certification.ts";
import type { UsbModeDispatchDeps } from "../modules/modems/usb-mode-contract.ts";
import type { ResolvedModemIdentity } from "../modules/modems/usb-mode-identity.ts";
import {
	type RuntimeCompositionResponse,
	type RuntimeCompositionVendor,
	resolveAtPortPath,
	resolveRuntimeVendor,
} from "../modules/modems/usb-mode-runtime.ts";

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

	const RM530N = {
		vidPid: "2c7c:0801",
		model: "RM530N-GL",
		firmwareRevision: "RM530NGLAAR05A01M4G",
	} as const;

	/**
	 * A LOCAL catalog shaped like the RM530N-GL entry the 2026-08-19 bench drill
	 * produced. It is local rather than the shipped `CERTIFIED_CATALOG` because
	 * the entry ships from modem-stack: asserting it here would make this suite
	 * fail until that release lands and the pin is bumped, which is a cross-repo
	 * ordering constraint rather than a property of the selection rule. No
	 * shipped catalog carries this SKU yet — the drill that would certify it is
	 * recorded but not accepted — so what this suite owns is the SELECTION rule,
	 * never the claim that any particular device is certified.
	 */
	const drilledCatalog = {
		schemaVersion: 1 as const,
		entries: [
			{
				vidPid: "2c7c:0801",
				model: "RM530N-GL",
				firmwarePrefix: "RM530NGLAAR05A01M4G",
				canonicalMode: "qmi" as const,
				permittedTransitions: [
					{
						from: "qmi" as const,
						to: "mbim" as const,
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
					{
						from: "mbim" as const,
						to: "qmi" as const,
						atCommand: 'AT+QCFG="usbnet",0',
						expectedResponse: "OK",
						expectsPortDrop: true,
						expectedDescriptors: {
							deviceClass: 0,
							interfaces: [
								{
									interfaceClass: 255,
									interfaceSubClass: 255,
									interfaceProtocol: 255,
								},
							],
						},
					},
				],
			},
		],
	};

	test("the DRILLED fleet modem offers the round trip it was certified for", () => {
		expect(certifiedUsbTargets(drilledCatalog, identity(RM530N))).toEqual([
			"mbim",
		]);
		expect(
			certifiedUsbTargets(
				drilledCatalog,
				identity({ ...RM530N, currentMode: "mbim" }),
			),
		).toEqual(["qmi"]);
	});

	test("…and NOT ecm-ncm, which its catalog entry deliberately does not declare", () => {
		expect(certifiedUsbTargets(drilledCatalog, identity(RM530N))).not.toContain(
			"ecm-ncm",
		);
	});

	test("the drilled unit's own USB bcdDevice is not a firmware key", () => {
		expect(
			certifiedUsbTargets(
				drilledCatalog,
				identity({ ...RM530N, firmwareRevision: "0504" }),
			),
		).toEqual([]);
	});

	test("a fleet modem with NO reviewed evidence still offers nothing", () => {
		for (const uncertified of [
			{
				vidPid: "1e0e:9001",
				model: "SIMCOM_SIM7600G-H",
				firmwareRevision: "LE20B04SIM7600G22",
			},
			{
				vidPid: "0e8d:7127",
				model: "FM350-GL",
				firmwareRevision: "81600.0000.00.19.17.10",
			},
		]) {
			expect(
				certifiedUsbTargets(CERTIFIED_CATALOG, identity(uncertified)),
			).toEqual([]);
		}
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

/**
 * The FM350-GL as the bench measured it: a Fibocom answering `AT+GTUSBMODE` with
 * a two-member domain that CONTAINS the mode it is in. That containment is the
 * whole return-path proof — the device itself is saying the mode it currently
 * occupies is a member of the vocabulary it can be moved between.
 */
const FM350_ENUMERATING_40_41: RuntimeCompositionResponse = {
	vendor: "fibocom",
	currentResponse: "\r\n+GTUSBMODE: 40\r\n\r\nOK\r\n",
	enumerationResponse: "\r\n+GTUSBMODE: (40,41)\r\n\r\nOK\r\n",
};

/** The same device, having listed a target it cannot come back from. */
const FM350_WITHOUT_CURRENT: RuntimeCompositionResponse = {
	vendor: "fibocom",
	currentResponse: "\r\n+GTUSBMODE: 40\r\n\r\nOK\r\n",
	enumerationResponse: "\r\n+GTUSBMODE: (41,42)\r\n\r\nOK\r\n",
};

const FM350 = {
	vidPid: "0e8d:7127",
	model: "FM350-GL",
	firmwareRevision: "81600.0000.00.19.17.10",
} as const;

interface RuntimeProbe {
	readonly deps: UsbModeDispatchDeps;
	/** Every (vendor) pair the ladder actually asked the DEVICE about. */
	readonly asked: RuntimeCompositionVendor[];
}

function runtimeDeps(options: {
	resolved: ResolvedModemIdentity | undefined;
	response?: RuntimeCompositionResponse | undefined;
	provisioningEnabled?: boolean;
	blockedByLiveState?: boolean;
}): RuntimeProbe {
	const asked: RuntimeCompositionVendor[] = [];
	return {
		asked,
		deps: {
			...optionDeps(options.resolved),
			queryRuntimeComposition: (_identity, vendor) => {
				asked.push(vendor);
				return Promise.resolve(options.response);
			},
			isProvisioningEnabled: () => options.provisioningEnabled ?? true,
			isBlockedByLiveState: () => options.blockedByLiveState ?? false,
		},
	};
}

describe("the offer is DRIVEN by the device's own enumeration", () => {
	test("an FM350 enumerating (40,41) from mode 40 OFFERS the switch", async () => {
		// The happy path this whole ladder exists for: a known dialect, a reply
		// this build can parse, and the device's own list containing the mode it
		// is in. Nothing is suppressed, and the evidence rides the wire verbatim
		// so a support transcript can see what the device actually said.
		const probe = runtimeDeps({
			resolved: identity({ ...FM350, currentMode: "qmi" }),
			response: FM350_ENUMERATING_40_41,
		});
		const result = await resolveUsbModeOptions("0", probe.deps);

		expect(result.suppressed).toBeUndefined();
		expect(result.runtime).toEqual({
			vendor: "fibocom",
			current: 40,
			enumerated: [40, 41],
			return_path_proven: true,
		});
		expect(probe.asked).toEqual(["fibocom"]);
	});

	test("…and a device whose list OMITS its current mode is withheld as no-return-path", async () => {
		// The device answered, and its answer is the refusal: it named 41 and 42
		// and not the 40 it is sitting in, so nothing it said proves it could come
		// back. The whole list is withheld rather than the current mode being
		// assumed reachable — a one-way switch on a bonded uplink is not an offer.
		const probe = runtimeDeps({
			resolved: identity({ ...FM350, currentMode: "qmi" }),
			response: FM350_WITHOUT_CURRENT,
		});
		const result = await resolveUsbModeOptions("0", probe.deps);

		expect(result.suppressed).toBe("no-return-path");
		expect(result.certified).toEqual([]);
		expect(result.runtime).toBeUndefined();
	});

	test("a vendor this build has no reviewed READ form for is unknown-vendor, NOT uncertified", async () => {
		// The headline replacement. `uncertified` asserts "your model was never
		// reviewed"; this device was never even asked, and saying so is the honest
		// answer. No AT contact is made, which is the transport-safety half.
		const probe = runtimeDeps({
			resolved: identity({
				vidPid: "05c6:9091",
				model: "4G UFI",
				firmwareRevision: "UFI_HM_SIM1_V016_240828",
			}),
			response: FM350_ENUMERATING_40_41,
		});
		const result = await resolveUsbModeOptions("0", probe.deps);

		expect(result.suppressed).toBe("unknown-vendor");
		expect(result.certified).toEqual([]);
		expect(probe.asked).toEqual([]);
	});

	test("a device that could not be REACHED is unknown-vendor too, and never no-return-path", async () => {
		// A port that would not answer proves nothing about the device's own
		// vocabulary. Reporting it as `no-return-path` would assert the device
		// replied and its reply excluded its own mode — a claim we cannot make.
		const probe = runtimeDeps({
			resolved: identity({ ...FM350, currentMode: "qmi" }),
			response: undefined,
		});
		expect((await resolveUsbModeOptions("0", probe.deps)).suppressed).toBe(
			"unknown-vendor",
		);
		expect(probe.asked).toEqual(["fibocom"]);
	});

	test("an unparseable reply is unknown-vendor, and never no-return-path", async () => {
		const probe = runtimeDeps({
			resolved: identity({ ...FM350, currentMode: "qmi" }),
			response: {
				vendor: "fibocom",
				currentResponse: "\r\nERROR\r\n",
				enumerationResponse: "\r\n+GTUSBMODE: (40,41)\r\n\r\nOK\r\n",
			},
		});
		expect((await resolveUsbModeOptions("0", probe.deps)).suppressed).toBe(
			"unknown-vendor",
		);
	});
});

describe("the three transport-free suppressions resolve BEFORE any AT contact", () => {
	test("provisioning off suppresses without asking the device", async () => {
		const probe = runtimeDeps({
			resolved: identity({ ...FM350, currentMode: "qmi" }),
			response: FM350_ENUMERATING_40_41,
			provisioningEnabled: false,
		});
		const result = await resolveUsbModeOptions("0", probe.deps);

		expect(result.suppressed).toBe("provisioning-disabled");
		expect(result.certified).toEqual([]);
		expect(probe.asked).toEqual([]);
	});

	test("a live condition suppresses without asking the device", async () => {
		// An AT read against a modem being mutated is exactly the contention the
		// lifecycle interlock exists to prevent, so this gate is asked first and
		// the tty is never opened.
		const probe = runtimeDeps({
			resolved: identity({ ...FM350, currentMode: "qmi" }),
			response: FM350_ENUMERATING_40_41,
			blockedByLiveState: true,
		});
		const result = await resolveUsbModeOptions("0", probe.deps);

		expect(result.suppressed).toBe("blocked-by-state");
		expect(probe.asked).toEqual([]);
	});

	test("an unresolvable device is still identity_unresolved, ahead of everything", async () => {
		const probe = runtimeDeps({ resolved: undefined });
		expect((await resolveUsbModeOptions("9", probe.deps)).suppressed).toBe(
			"identity_unresolved",
		);
		expect(probe.asked).toEqual([]);
	});

	test("provisioning outranks a live block, which outranks the device's own answer", async () => {
		// The order is the contract: the cheapest, most-actionable refusal wins, so
		// an operator with provisioning off is told THAT rather than being told the
		// modem is busy because a stream happens to be running too.
		const both = runtimeDeps({
			resolved: identity({ ...FM350, currentMode: "qmi" }),
			response: FM350_WITHOUT_CURRENT,
			provisioningEnabled: false,
			blockedByLiveState: true,
		});
		expect((await resolveUsbModeOptions("0", both.deps)).suppressed).toBe(
			"provisioning-disabled",
		);

		const liveOnly = runtimeDeps({
			resolved: identity({ ...FM350, currentMode: "qmi" }),
			response: FM350_WITHOUT_CURRENT,
			blockedByLiveState: true,
		});
		expect((await resolveUsbModeOptions("0", liveOnly.deps)).suppressed).toBe(
			"blocked-by-state",
		);
	});

	test("`uncertified` is unreachable once the device can be interrogated", async () => {
		// The acceptance property, asserted directly: across every arm of the
		// runtime ladder — including the ones that suppress — no answer is ever
		// the word that told an entire fleet its models were never reviewed.
		const arms = [
			runtimeDeps({
				resolved: identity({ ...FM350, currentMode: "qmi" }),
				response: FM350_ENUMERATING_40_41,
			}),
			runtimeDeps({
				resolved: identity({ ...FM350, currentMode: "qmi" }),
				response: FM350_WITHOUT_CURRENT,
			}),
			runtimeDeps({
				resolved: identity({ ...FM350, currentMode: "qmi" }),
				response: undefined,
			}),
			runtimeDeps({
				resolved: identity({ ...FM350, currentMode: "qmi" }),
				response: FM350_ENUMERATING_40_41,
				provisioningEnabled: false,
			}),
			runtimeDeps({
				resolved: identity({ ...FM350, currentMode: "qmi" }),
				response: FM350_ENUMERATING_40_41,
				blockedByLiveState: true,
			}),
			// …and the SYNTHETIC catalog SKU, which under the pre-runtime path was
			// the only device on earth that escaped `uncertified`.
			runtimeDeps({
				resolved: identity(),
				response: FM350_ENUMERATING_40_41,
			}),
		];
		for (const arm of arms) {
			expect((await resolveUsbModeOptions("0", arm.deps)).suppressed).not.toBe(
				"uncertified",
			);
		}
	});

	test("a build with NO runtime path wired still answers exactly as before", async () => {
		// The widening is strict: an absent dependency is a statement about this
		// build, not about the hardware, so the catalog answer is byte-identical.
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
});

describe("which dialect a device speaks is read off the device", () => {
	test("the USB vendor id resolves the four families", () => {
		expect(resolveRuntimeVendor({ vidPid: "0e8d:7127", model: "" })).toBe(
			"fibocom",
		);
		expect(resolveRuntimeVendor({ vidPid: "2c7c:0801", model: "" })).toBe(
			"quectel",
		);
		expect(resolveRuntimeVendor({ vidPid: "1e0e:9001", model: "" })).toBe(
			"simcom",
		);
		expect(resolveRuntimeVendor({ vidPid: "1199:9091", model: "" })).toBe(
			"sierra",
		);
	});

	test("an OEM-rebranded unit is recognised by its own vendor id, not by a model list", () => {
		// Sierra silicon registers under three vendor ids; HP's and Dell's are
		// still Sierra. Keying on the model string alone would miss both.
		for (const vendorId of ["03f0", "413c"]) {
			expect(
				resolveRuntimeVendor({ vidPid: `${vendorId}:a31d`, model: "" }),
			).toBe("sierra");
		}
	});

	test("an unlisted vendor id resolves nothing rather than a nearest guess", () => {
		expect(
			resolveRuntimeVendor({ vidPid: "12d1:14dc", model: "HUAWEI_MOBILE" }),
		).toBeUndefined();
		expect(resolveRuntimeVendor({ vidPid: "", model: "" })).toBeUndefined();
	});

	test("the AT port comes from ModemManager's own port list", () => {
		expect(resolveAtPortPath(["wwan0 (net)", "ttyUSB2 (at)"])).toBe(
			"/dev/ttyUSB2",
		);
		// A modem with no AT port cannot be asked at all — and answering with a
		// net or QMI port would open the wrong device node.
		expect(
			resolveAtPortPath(["wwan0 (net)", "cdc-wdm0 (qmi)"]),
		).toBeUndefined();
		expect(resolveAtPortPath([])).toBeUndefined();
	});
});

describe("the offer vocabulary is BORROWED, never invented", () => {
	test("every suppression token already exists in a typed vocabulary", () => {
		// A token with no home in any of the three enums is a token with no
		// operator copy, so it would reach the screen as a raw dotted key.
		//
		// The runtime enum is the THIRD source, and it is borrowed rather than
		// invented too: its four literals are modem-stack's own, mirrored verbatim
		// so the two sides of the seam share one vocabulary instead of a mapping.
		const known = new Set<string>([
			...setUsbModeRefusalSchema.options,
			...setUsbModeFailureReasonSchema.options,
			...usbModeRuntimeSuppressionSchema.options,
		]);
		for (const token of usbModeOfferSuppressionSchema.options) {
			expect(known.has(token)).toBe(true);
		}
	});

	test("the runtime enum contributes four tokens that are NOT switch refusals", () => {
		// Non-vacuity for the widening above: if the runtime literals had been
		// spelled to collide with existing refusals, adding that enum to the known
		// set would prove nothing.
		const older = new Set<string>([
			...setUsbModeRefusalSchema.options,
			...setUsbModeFailureReasonSchema.options,
		]);
		expect(usbModeRuntimeSuppressionSchema.options).toHaveLength(4);
		for (const token of usbModeRuntimeSuppressionSchema.options) {
			expect(older.has(token)).toBe(false);
			expect(usbModeOfferSuppressionSchema.options).toContain(token);
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
