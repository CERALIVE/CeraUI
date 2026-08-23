/**
 * `derive.ts` — the section set, and the GUARANTEED MINIMUM BASELINE as a
 * property of the model rather than of any one render site.
 *
 * The interesting assertions here are the ones about ABSENCE: what a device that
 * published nothing gets, and what a device that published half a fact must NOT
 * get. Those are the cases a rendered-DOM test can only reach through a fixture,
 * and they are the cases the whole directory exists for.
 */

import type {
	CapabilityModuleClaims,
	Modem,
	SupportClaimState,
} from "@ceraui/rpc/schemas";
import { CAPABILITY_MODULES } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { isSimlessModem } from "$main/network/cellular-row";

import {
	BASELINE_UNAVAILABLE_KEY,
	DEFAULT_CAPABILITY_REASONS,
	deriveCapabilityView,
	deriveCapabilityViews,
	deriveModemSections,
	SIGNAL_UNREADABLE_KEY,
	UNNAMED_TITLE_KEY,
} from "./derive";

/** The floor every fixture starts from: the three fields the wire requires. */
function modem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "",
		network_type: { supported: [], active: null },
		...overrides,
	} as Modem;
}

/**
 * A device with NO provider match, NO capabilities and the barest telemetry —
 * the acceptance case. It is deliberately built from the schema's required
 * fields alone: anything more would be testing a device we already understand.
 */
const UNRECOGNIZED = modem({ ifname: "wwan9" });

describe("the guaranteed minimum baseline", () => {
	it("derives a complete set for an unrecognized device, and throws nothing", () => {
		expect(() => deriveModemSections({ modem: UNRECOGNIZED })).not.toThrow();

		const set = deriveModemSections({ modem: UNRECOGNIZED });
		expect(Object.keys(set).sort()).toEqual([
			"connection",
			"diagnostics",
			"identity",
			"signal",
			"sim",
			"unavailability",
		]);
	});

	it("always renders an identity, falling back to the interface name", () => {
		const set = deriveModemSections({ modem: UNRECOGNIZED });

		expect(set.identity.title).toBe("wwan9");
		expect(set.identity.titleKey).toBeUndefined();
		// The interface name is a real identity, but the DEVICE named itself
		// nothing — and the block says so rather than passing a kernel name off as
		// a product name.
		expect(set.identity.identified).toBe(false);
	});

	it("falls back to a stand-in KEY only when even the interface name is empty", () => {
		const set = deriveModemSections({ modem: modem({ ifname: "" }) });

		expect(set.identity.title).toBe("");
		expect(set.identity.titleKey).toBe(UNNAMED_TITLE_KEY);
	});

	it("states the unavailability with a reason rather than leaving the card mute", () => {
		const set = deriveModemSections({ modem: UNRECOGNIZED });

		expect(set.unavailability).toHaveLength(1);
		expect(set.unavailability[0]).toEqual({
			id: "baseline",
			reasonKey: BASELINE_UNAVAILABLE_KEY,
		});
	});

	it("claims no capability it was never told about", () => {
		const views = deriveCapabilityViews(UNRECOGNIZED.capability_modules);

		for (const module of CAPABILITY_MODULES) {
			expect(views[module]).toEqual({ mode: "absent" });
		}
	});

	/*
	  The floor is a FLOOR, not a blanket. A device that told us what it is doing
	  has already explained itself, and adding "nothing was reported" under a
	  connected radio would be the opposite of honest.
	*/
	it("does NOT fire the floor for a device that reported a lifecycle state", () => {
		const set = deriveModemSections({
			modem: modem({
				name: "RM530N-GL",
				status: {
					connection: "connected",
					network_type: "lte",
					signal: 86,
					roaming: false,
				},
			}),
		});

		expect(set.unavailability).toEqual([]);
		expect(set.connection.state).toBe("connected");
	});

	it("does NOT fire the floor when the device stated its own reason", () => {
		const set = deriveModemSections({
			modem: modem({ availability_reason: "modem_initializing" }),
		});

		const keys = set.unavailability.map((note) => note.reasonKey);
		expect(keys).not.toContain(BASELINE_UNAVAILABLE_KEY);
		expect(keys).toHaveLength(1);
		expect(set.unavailability[0]?.id).toBe("availability");
	});
});

describe("telemetry renders when it is readable, and says so when it is not", () => {
	it("reads the board's own modem service when it published a level", () => {
		const set = deriveModemSections({
			modem: modem({
				status: {
					connection: "connected",
					network_type: "lte",
					signal: 86,
					roaming: false,
				},
			}),
		});

		expect(set.signal).toEqual({
			readable: true,
			tier: "high",
			tierKey: "network.cellular.signal.high",
			provenance: "device-stack",
			stale: false,
		});
	});

	it("reads a level the device published about itself, and marks a carried one", () => {
		const set = deriveModemSections({
			modem: modem({
				router_admin: {
					admin_url: "http://192.168.8.1/",
					signal: {
						provenance: "hilink-admin-api",
						freshness: "stale",
						bars: { state: "known", value: 4 },
						max_bars: { state: "known", value: 5 },
						dbm: { state: "unknown", reason: "not-reported" },
						rsrp: { state: "unknown", reason: "not-reported" },
						rsrq: { state: "unknown", reason: "not-reported" },
						snr: { state: "unknown", reason: "unsupported" },
						sinr: { state: "unknown", reason: "not-reported" },
					},
				},
			} as Partial<Modem>),
		});

		expect(set.signal).toEqual({
			readable: true,
			tier: "high",
			tierKey: "network.cellular.signal.high",
			provenance: "device-admin",
			stale: true,
		});
	});

	it("states an unreadable signal in words — never a tier, never a zero", () => {
		const set = deriveModemSections({ modem: UNRECOGNIZED });

		expect(set.signal).toEqual({
			readable: false,
			reasonKey: SIGNAL_UNREADABLE_KEY,
		});
	});

	/*
	  An empty slot is the SIM block's fact and is stated there. Repeating it as a
	  signal reason would put one condition on screen twice, which is how a row
	  grows into the wall of sentences this surface was built to remove.
	*/
	it("does not repeat an empty slot as a signal reason", () => {
		const set = deriveModemSections({
			modem: modem({
				router_admin: {
					sim: "absent",
					signal: {
						provenance: "hilink-admin-api",
						freshness: "live",
						bars: { state: "unknown", reason: "not-reported" },
						max_bars: { state: "unknown", reason: "not-reported" },
						dbm: { state: "unknown", reason: "not-reported" },
						rsrp: { state: "unknown", reason: "not-reported" },
						rsrq: { state: "unknown", reason: "not-reported" },
						snr: { state: "unknown", reason: "unsupported" },
						sinr: { state: "unknown", reason: "not-reported" },
					},
				},
			} as Partial<Modem>),
		});

		expect(set.signal).toEqual({
			readable: false,
			reasonKey: SIGNAL_UNREADABLE_KEY,
		});
		expect(set.sim).toEqual({ presence: "absent" });
	});
});

describe("the SIM answer comes from the shared predicate, for every class", () => {
	it("reads an empty slot through the field the board's modem service uses", () => {
		expect(deriveModemSections({ modem: modem({ no_sim: true }) }).sim).toEqual(
			{
				presence: "absent",
			},
		);
	});

	it("reads an empty slot through the field the device itself publishes", () => {
		const set = deriveModemSections({
			modem: modem({ router_admin: { sim: "absent" } } as Partial<Modem>),
		});
		expect(set.sim).toEqual({ presence: "absent" });
	});

	it("surfaces a blocking lock and names which one", () => {
		const set = deriveModemSections({
			modem: modem({ sim_lock: { required: "sim-puk" } } as Partial<Modem>),
		});
		expect(set.sim).toEqual({ presence: "locked", lock: "sim-puk" });
	});

	/*
	  A lock this product exposes no surface for gates nothing an operator here
	  can reach, so the row must be indistinguishable from an unlocked one.
	*/
	it("does not surface a lock this UI deliberately never renders", () => {
		const set = deriveModemSections({
			modem: modem({
				sim_lock: { required: "sim-pin2" },
				no_sim: false,
			} as Partial<Modem>),
		});
		expect(set.sim).toEqual({ presence: "present" });
	});

	it("answers `unknown` on no evidence, never an optimistic `present`", () => {
		expect(deriveModemSections({ modem: UNRECOGNIZED }).sim).toEqual({
			presence: "unknown",
		});
	});
});

/*
  `no_sim` is the BOND fold, and it is lossy by design: the device answers
  `presence !== "present"`, so a slot it could not read leaves it as the same
  `true` an empty slot does. That is right for a pool a link either joins or does
  not; rendering it as `absent` asserts a device fact nobody established.

  `sim_presence` is the reading that fold consumes, published beside it, and it
  is preferred here. The last two cases are the ones that keep this a RENDERING
  fix: the bond predicate is re-asserted against the very same fixture, and the
  legacy path is proven byte-unchanged for a backend that publishes no such field.
*/
describe("the device's own slot evidence outranks the bond fold", () => {
	const UNREADABLE_SLOT = modem({
		no_sim: true,
		sim_presence: "unknown",
	} as Partial<Modem>);

	it("renders `unknown` for a slot the device could not read", () => {
		expect(deriveModemSections({ modem: UNREADABLE_SLOT }).sim).toEqual({
			presence: "unknown",
		});
	});

	it("still keeps that link OUT of the bond, by the unchanged predicate", () => {
		expect(isSimlessModem(UNREADABLE_SLOT)).toBe(true);
	});

	it("renders `absent` only where the device positively said so", () => {
		const set = deriveModemSections({
			modem: modem({ no_sim: true, sim_presence: "absent" } as Partial<Modem>),
		});
		expect(set.sim).toEqual({ presence: "absent" });
	});

	it("lets a blocking lock outrank a populated slot, as before", () => {
		const set = deriveModemSections({
			modem: modem({
				sim_presence: "present",
				sim_lock: { required: "sim-puk" },
			} as Partial<Modem>),
		});
		expect(set.sim).toEqual({ presence: "locked", lock: "sim-puk" });
	});

	it("falls back to the fold for a backend that publishes no reading", () => {
		expect(deriveModemSections({ modem: modem({ no_sim: true }) }).sim).toEqual(
			{
				presence: "absent",
			},
		);
		expect(
			deriveModemSections({ modem: modem({ no_sim: false }) }).sim,
		).toEqual({ presence: "present" });
	});

	/*
	  A `router-ethernet` dongle has no slot reading of its own and publishes no
	  `sim_presence` at all, so its whole answer must still come from the field it
	  does publish. This is the class the shared predicate was introduced for.
	*/
	it("leaves the router-dongle class on its own field", () => {
		expect(
			deriveModemSections({
				modem: modem({ router_admin: { sim: "absent" } } as Partial<Modem>),
			}).sim,
		).toEqual({ presence: "absent" });
		expect(
			deriveModemSections({
				modem: modem({ router_admin: { sim: "present" } } as Partial<Modem>),
			}).sim,
		).toEqual({ presence: "present" });
	});
});

describe("diagnostics carry the raw values, and only the stated ones", () => {
	it("omits a field the device did not state — never a dash", () => {
		const { diagnostics } = deriveModemSections({ modem: UNRECOGNIZED });

		expect(diagnostics.rows.map((row) => row.id)).toEqual(["interface"]);
		expect(diagnostics.rows[0]?.value).toBe("wwan9");
	});

	it("passes every stated value through verbatim", () => {
		const { diagnostics } = deriveModemSections({
			modem: modem({
				ifname: "enx0c5b8f279a64",
				device_class: "router-ethernet",
				availability_reason: "router_direct",
				packet_service_state: "attached",
				usb_mode: "rndis",
				firmware_revision: "BD_XCBZHKMF79UV1.0.0B03",
				iccid: "8934071100000000000",
				stable_key: "usb-0:1.2",
				lock_state: "open",
			} as Partial<Modem>),
		});

		expect(
			Object.fromEntries(diagnostics.rows.map((r) => [r.id, r.value])),
		).toEqual({
			interface: "enx0c5b8f279a64",
			transport: "router-ethernet",
			availability: "router_direct",
			"packet-service": "attached",
			"usb-composition": "rndis",
			firmware: "BD_XCBZHKMF79UV1.0.0B03",
			"sim-id": "8934071100000000000",
			"stable-key": "usb-0:1.2",
			"admin-login": "open",
		});
	});

	it("every row carries a KEY, never a pre-baked sentence", () => {
		const { diagnostics } = deriveModemSections({
			modem: modem({ firmware_revision: "1.0" }),
		});

		for (const row of diagnostics.rows) {
			expect(row.labelKey).toMatch(/^[a-z][A-Za-z.]+$/);
			expect(row.labelKey.includes(" ")).toBe(false);
		}
	});
});

describe("unavailability is the row's own authority, re-shaped", () => {
	/*
	  A bond refusal is a claim about an address. Told nothing about the address,
	  the set claims nothing — inventing "this link has no address" from an absent
	  input is the fabrication the whole surface exists to prevent.
	*/
	it("omits the bond refusal entirely when the caller supplied no address fact", () => {
		const set = deriveModemSections({ modem: modem({ no_sim: true }) });

		expect(set.unavailability.map((n) => n.id)).not.toContain("bond");
	});

	it("emits it once the caller supplies one", () => {
		const set = deriveModemSections({
			modem: modem({ no_sim: true }),
			hasAddress: false,
		});

		const bond = set.unavailability.find((n) => n.id === "bond");
		expect(bond?.reasonKey).toBe("network.view.noSimBond");
	});

	it("keeps the row's de-duplication rather than restating one fact twice", () => {
		const set = deriveModemSections({
			modem: modem({
				device_class: "router-ethernet",
				availability_reason: "router_direct",
			} as Partial<Modem>),
		});

		const keys = set.unavailability.map((n) => n.reasonKey);
		expect(new Set(keys).size).toBe(keys.length);
		// The specific refusal supersedes the generic sentence it contains.
		expect(keys).toContain("network.cellular.reason.routerControlsUnverified");
		expect(keys).not.toContain("network.cellular.reason.routerManaged");
	});

	it("names WHERE each surviving reason came from", () => {
		const set = deriveModemSections({
			modem: modem({
				registration_rejection: { error: "plmn-not-allowed" },
			} as Partial<Modem>),
		});

		expect(set.unavailability[0]).toEqual({
			id: "rejection",
			reasonKey: "network.cellular.rejection.plmnNotAllowed",
		});
	});
});

describe("the capability ladder is the shared one, not a second copy", () => {
	const LADDER: ReadonlyArray<[SupportClaimState | undefined, string]> = [
		[undefined, "absent"],
		["unavailable", "absent"],
		["implemented", "unknown"],
		["enabled", "unknown"],
		["capable", "available"],
		["certified", "available"],
	];

	for (const [claim, mode] of LADDER) {
		it(`${claim ?? "an absent claim"} resolves to ${mode}`, () => {
			expect(deriveCapabilityView(claim).mode).toBe(mode);
		});
	}

	it("uses the generic reason pair by default", () => {
		const view = deriveCapabilityView("implemented");
		expect(view).toEqual({
			mode: "unknown",
			reasonKey: DEFAULT_CAPABILITY_REASONS.moduleDisabled,
		});
	});

	/*
	  CT-4: a current refusal cannot promote an unproven module into a disabled
	  control. Passing one below `capable` must be ignored, not honoured.
	*/
	it("ignores a current refusal below `capable`", () => {
		expect(deriveCapabilityView("enabled", undefined, "some.reason")).toEqual({
			mode: "unknown",
			reasonKey: DEFAULT_CAPABILITY_REASONS.unproven,
		});
	});

	it("honours a current refusal at or above `capable`", () => {
		expect(deriveCapabilityView("capable", undefined, "some.reason")).toEqual({
			mode: "blocked",
			reasonKey: "some.reason",
		});
	});

	it("is TOTAL over the module list, so a section cannot be silently omitted", () => {
		const claims = { gps: "capable" } as unknown as CapabilityModuleClaims;
		const views = deriveCapabilityViews(claims);

		expect(Object.keys(views).sort()).toEqual([...CAPABILITY_MODULES].sort());
		expect(views.gps.mode).toBe("available");
		expect(views.sms.mode).toBe("absent");
	});
});
