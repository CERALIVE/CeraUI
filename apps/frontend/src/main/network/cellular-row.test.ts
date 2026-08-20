/**
 * cellular-row — the pure row derivation behind CellularSection (todo 26).
 *
 * The rules that matter here are all refusals: an unrecognised transport must
 * resolve to an honest generic band rather than to one of the two we know, an
 * unrecognised `availability_reason` must never reach an operator as a raw
 * token, and a device that reported no radio status must draw NO signal glyph
 * rather than an empty one.
 */
import type { Modem } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	activeSimLock,
	availabilityReasonKey,
	bondDisabledReasonKey,
	carrierLabel,
	classHintKey,
	classLabelKey,
	configureDisabledReasonKey,
	detailLine,
	isBlockingSimLock,
	isRoamingActive,
	type ModemClassBand,
	type ModemRowState,
	primaryLabel,
	registrationRejectionKey,
	resolveClassBand,
	resolveRowAction,
	resolveRowState,
	resolveSignalTier,
	rowNoteKeys,
	signalLabelKey,
	slotBadgeLabel,
	stateLabelKey,
	stateTone,
} from "./cellular-row";

function modem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "usb0",
		name: "EG25-G - 12345",
		network_type: { supported: ["4G"], active: "4G" },
		...overrides,
	} as Modem;
}

describe("resolveClassBand", () => {
	it.each([
		["usb", "mm-managed"],
		["pcie-mhi", "mm-managed"],
		["pcie-mtk", "mm-managed"],
		["soc-qrtr", "mm-managed"],
		["router-ethernet", "router-ethernet"],
	] as const)("%s -> %s", (deviceClass, band) => {
		expect(resolveClassBand(deviceClass)).toBe(band);
	});

	it("an ABSENT class is mm-managed — the legacy wire came from mmcli only", () => {
		expect(resolveClassBand(undefined)).toBe("mm-managed");
	});

	it("an UNRECOGNISED class is unmanaged, never guessed into a known band", () => {
		expect(resolveClassBand("thunderbolt-wwan")).toBe("unmanaged");
		expect(resolveClassBand("")).toBe("unmanaged");
	});
});

describe("resolveRowState", () => {
	it("a missing SIM outranks everything else", () => {
		const m = modem({
			no_sim: true,
			status: {
				connection: "connected",
				signal: 80,
				roaming: false,
				network_type: "4G",
			},
		});
		expect(resolveRowState(m, "mm-managed")).toBe("no-sim");
	});

	it.each(["sim-pin", "sim-pin2", "sim-puk", "sim-puk2"] as const)(
		"%s renders the locked state",
		(required) => {
			const m = modem({ sim_lock: { required } });
			expect(resolveRowState(m, "mm-managed")).toBe("locked");
		},
	);

	it.each(["none", "unknown"] as const)(
		"%s is NOT a lock — an unknown lock state is not a claim",
		(required) => {
			const m = modem({ sim_lock: { required } });
			expect(resolveRowState(m, "mm-managed")).toBe("unknown");
		},
	);

	it.each([
		"connected",
		"connecting",
		"registered",
		"scanning",
		"failed",
	] as const)("a reported connection passes through: %s", (connection) => {
		const m = modem({
			status: { connection, signal: 55, roaming: false, network_type: "4G" },
		});
		expect(resolveRowState(m, "mm-managed")).toBe(connection);
	});

	it.each([
		["router_managed", "router-up"],
		["dongle_acquiring", "router-acquiring"],
		["dongle_down", "router-down"],
	] as const)(
		"a statusless router row derives its lifecycle from %s",
		(reason, state) => {
			const m = modem({
				ifname: "dg0h",
				name: "dongle0",
				device_class: "router-ethernet",
				availability_reason: reason,
			});
			expect(resolveRowState(m, "router-ethernet")).toBe(state);
		},
	);

	it("an UNKNOWN reason never becomes `router-up` — that would be a claim", () => {
		const m = modem({
			ifname: "dg0h",
			name: "dongle0",
			device_class: "router-ethernet",
			availability_reason: "some_future_token",
		});
		expect(resolveRowState(m, "router-ethernet")).toBe("unknown");
	});

	it("an unmanaged device with nothing reported is `unknown`, not `failed`", () => {
		expect(resolveRowState(modem(), "unmanaged")).toBe("unknown");
	});
});

describe("state presentation", () => {
	const STATES: ModemRowState[] = [
		"connected",
		"connecting",
		"registered",
		"scanning",
		"failed",
		"locked",
		"no-sim",
		"router-up",
		"router-acquiring",
		"router-down",
		"unknown",
	];

	it("every state carries its own WORD (a label key) and a tone", () => {
		for (const state of STATES) {
			expect(stateLabelKey(state)).toMatch(/^[a-z]+\./);
			expect(stateTone(state)).toBeTruthy();
		}
	});

	it("label keys are distinct per state — no two states read the same", () => {
		const keys = STATES.map(stateLabelKey);
		expect(new Set(keys).size).toBe(STATES.length);
	});

	it.each([
		["connected", "live"],
		["router-up", "live"],
		["connecting", "pending"],
		["router-acquiring", "pending"],
		["locked", "attention"],
		["no-sim", "attention"],
		["failed", "error"],
		["router-down", "error"],
		["unknown", "idle"],
	] as const)("%s tone is %s", (state, tone) => {
		expect(stateTone(state)).toBe(tone);
	});
});

describe("class presentation", () => {
	const BANDS: ModemClassBand[] = [
		"mm-managed",
		"router-ethernet",
		"unmanaged",
	];

	it("every band has its own label and its own explanatory hint", () => {
		const labels = BANDS.map(classLabelKey);
		const hints = BANDS.map(classHintKey);
		expect(new Set(labels).size).toBe(BANDS.length);
		expect(new Set(hints).size).toBe(BANDS.length);
		expect(new Set([...labels, ...hints]).size).toBe(BANDS.length * 2);
	});
});

describe("availabilityReasonKey", () => {
	it.each([
		["router_managed", "network.cellular.reason.routerManaged"],
		["dongle_acquiring", "network.dongle.blockedAcquiring"],
		["dongle_down", "network.dongle.blockedDown"],
	])("%s -> %s", (token, key) => {
		expect(availabilityReasonKey(token)).toBe(key);
	});

	it("an unknown token resolves to generic copy, NEVER to the token", () => {
		const key = availabilityReasonKey("some_future_token");
		expect(key).toBe("network.cellular.reason.unknown");
		expect(key).not.toContain("some_future_token");
	});

	it("absent / blank means there is nothing to explain", () => {
		expect(availabilityReasonKey(undefined)).toBeUndefined();
		expect(availabilityReasonKey("   ")).toBeUndefined();
	});
});

describe("resolveSignalTier", () => {
	it.each([
		[100, "high"],
		[70, "high"],
		[69, "medium"],
		[40, "medium"],
		[39, "low"],
		[1, "low"],
		[0, "none"],
	] as const)("%s -> %s", (signal, tier) => {
		expect(resolveSignalTier(signal)).toBe(tier);
	});

	it("NO reported signal draws NO glyph — an empty meter reads as no signal", () => {
		expect(resolveSignalTier(undefined)).toBeUndefined();
		expect(resolveSignalTier(Number.NaN)).toBeUndefined();
	});

	it("every tier has its own word", () => {
		const keys = (["high", "medium", "low", "none"] as const).map(
			signalLabelKey,
		);
		expect(new Set(keys).size).toBe(4);
	});
});

describe("bondDisabledReasonKey", () => {
	it("a no-SIM modem keeps its toggle, disabled with the no-SIM reason", () => {
		expect(
			bondDisabledReasonKey(
				modem({ no_sim: true }),
				"mm-managed",
				"no-sim",
				false,
			),
		).toBe("network.view.noSimBond");
	});

	it("an addressed MM-managed modem gets a LIVE toggle", () => {
		expect(
			bondDisabledReasonKey(modem(), "mm-managed", "connected", true),
		).toBeUndefined();
	});

	it("an address-less modem keeps its toggle, disabled with a reason", () => {
		expect(
			bondDisabledReasonKey(modem(), "mm-managed", "scanning", false),
		).toBe("network.cellular.bond.noAddress");
	});

	it.each([
		["router-acquiring", "network.dongle.blockedAcquiring"],
		["router-down", "network.dongle.blockedDown"],
		["router-up", "network.cellular.bond.routerManagedLink"],
	] as const)(
		"a router row is never live here (%s) — its veth owns the live toggle",
		(state, key) => {
			expect(
				bondDisabledReasonKey(
					modem({ device_class: "router-ethernet" }),
					"router-ethernet",
					state,
					true,
				),
			).toBe(key);
		},
	);

	it("an unmanaged device with an address is still bondable", () => {
		expect(
			bondDisabledReasonKey(modem(), "unmanaged", "unknown", true),
		).toBeUndefined();
	});
});

describe("configureDisabledReasonKey", () => {
	it("MM-managed is the only configurable band", () => {
		expect(configureDisabledReasonKey("mm-managed")).toBeUndefined();
	});

	it.each([
		["router-ethernet", "network.cellular.reason.routerManaged"],
		["unmanaged", "network.cellular.config.unmanaged"],
	] as const)("%s is disabled with a reason", (band, key) => {
		expect(configureDisabledReasonKey(band)).toBe(key);
	});

	it("a router dongle REUSES its availability reason — the same fact, stated once", () => {
		expect(configureDisabledReasonKey("router-ethernet")).toBe(
			availabilityReasonKey("router_managed"),
		);
	});

	// The capability gate, both ways. `controls` is the backend's claim that a
	// write to THIS device was proven to land, so it is the only thing that may
	// open the dialog — a dongle that merely ANSWERS reads must stay refused.
	it("a dongle with proven-writable settings becomes configurable", () => {
		const withControls = {
			router_admin: {
				admin_url: "http://192.168.8.1",
				reachable: true,
				controls: { mobile_data: true, roaming_autoconnect: false },
			},
		} as unknown as Modem;
		expect(
			configureDisabledReasonKey("router-ethernet", withControls),
		).toBeUndefined();
	});

	it("a readable-but-unwritable dongle stays refused", () => {
		const readOnly = {
			router_admin: { admin_url: "http://192.168.0.1", reachable: true },
		} as unknown as Modem;
		expect(configureDisabledReasonKey("router-ethernet", readOnly)).toBe(
			"network.cellular.reason.routerManaged",
		);
	});
});

describe("rowNoteKeys", () => {
	it("keeps order and drops nothing that adds information", () => {
		expect(
			rowNoteKeys({ availability: "a", bond: "b", configure: "c" }),
		).toEqual(["a", "b", "c"]);
	});

	it("collapses a reason two controls share", () => {
		expect(
			rowNoteKeys({ availability: "a", bond: "a", configure: "b" }),
		).toEqual(["a", "b"]);
		expect(
			rowNoteKeys({ availability: "a", bond: "b", configure: "a" }),
		).toEqual(["a", "b"]);
	});

	it("a fully healthy row explains nothing, because there is nothing to explain", () => {
		expect(rowNoteKeys({})).toEqual([]);
	});

	it("every router lifecycle state costs at most TWO lines", () => {
		for (const reason of [
			"router_managed",
			"dongle_acquiring",
			"dongle_down",
		]) {
			const availability = availabilityReasonKey(reason);
			const state = resolveRowState(
				modem({
					device_class: "router-ethernet",
					availability_reason: reason,
				}),
				"router-ethernet",
			);
			const notes = rowNoteKeys({
				availability,
				bond: bondDisabledReasonKey(
					modem({ device_class: "router-ethernet" }),
					"router-ethernet",
					state,
					true,
				),
				configure: configureDisabledReasonKey("router-ethernet"),
			});
			expect(notes.length, reason).toBeLessThanOrEqual(2);
			expect(new Set(notes).size, reason).toBe(notes.length);
		}
	});
});

describe("labels", () => {
	// The reported defect, pinned: a connected row used to be TITLED with its
	// carrier, so the device and its identifier were pushed out of the headline
	// at the exact moment the operator needed to know which unit was live.
	it("the hardware leads even once the radio has a carrier", () => {
		const connected = modem({
			status: {
				connection: "connected",
				signal: 60,
				roaming: false,
				network_type: "4G",
				network: "Vodafone",
			},
		});
		expect(primaryLabel(connected)).toBe("EG25-G - 12345");
		expect(primaryLabel(modem({ sim_network: "Movistar" }))).toBe(
			"EG25-G - 12345",
		);
		expect(primaryLabel(modem())).toBe("EG25-G - 12345");
	});

	it("the carrier is reported separately, registration first", () => {
		expect(
			carrierLabel(
				modem({
					sim_network: "Movistar",
					status: {
						connection: "connected",
						signal: 60,
						roaming: false,
						network_type: "4G",
						network: "Vodafone",
					},
				}),
			),
		).toBe("Vodafone");
		expect(carrierLabel(modem({ sim_network: "Movistar" }))).toBe("Movistar");
	});

	it("a blank carrier is not a carrier", () => {
		expect(carrierLabel(modem({ sim_network: "   " }))).toBeUndefined();
		expect(primaryLabel(modem({ sim_network: "   " }))).toBe("EG25-G - 12345");
	});

	it("the detail line never repeats the headline", () => {
		const m = modem({
			status: {
				connection: "connected",
				signal: 60,
				roaming: false,
				network_type: "4G",
				network: "Vodafone",
			},
		});
		expect(detailLine(m, primaryLabel(m))).toBe("4G");
		expect(detailLine(modem({ name: "dongle0" }), "dongle0")).toBeUndefined();
	});

	it("the slot badge is suppressed when it merely repeats the headline", () => {
		expect(slotBadgeLabel(modem({ slot_label: "SIM 1" }), "Vodafone")).toBe(
			"SIM 1",
		);
		expect(
			slotBadgeLabel(modem({ slot_label: "dongle0" }), "dongle0"),
		).toBeUndefined();
		expect(slotBadgeLabel(modem(), "Vodafone")).toBeUndefined();
	});
});

/**
 * Real-hardware regression (2026-08-16, Rock 5B+ with a Quectel RM530N-GL and a
 * SIMCom SIM7600G-H): the periodic `modems` broadcast sends a STATUS-ONLY
 * partial for an already-known modem, and `detailLine` dereferenced `name`
 * unguarded — so the first partial to arrive before a full snapshot threw and
 * took the WHOLE Network view into the top-level error boundary.
 */
describe("a status-only partial broadcast never crashes a row", () => {
	const partial = { status: { connection: "enabled" } } as unknown as Modem;

	it("detailLine survives a nameless entry", () => {
		expect(() => detailLine(partial, "2")).not.toThrow();
		expect(detailLine(partial, "2")).toBeUndefined();
	});

	it("primaryLabel falls back to the modem id rather than returning undefined", () => {
		expect(primaryLabel(partial, "2")).toBe("2");
		expect(primaryLabel(partial)).toBe("");
	});

	it("a nameless entry still resolves a state, a tone and a label", () => {
		const state = resolveRowState(partial, "mm-managed");
		expect(state).toBe("enabled");
		expect(stateTone(state)).toBe("pending");
		expect(stateLabelKey(state)).toBe("network.modem.connectionStatus.enabled");
	});

	it("the slot label is the headline when the hardware name never arrived", () => {
		const slotted = {
			status: { connection: "enabled" },
			slot_label: "SIM 1",
		} as unknown as Modem;
		expect(primaryLabel(slotted, "2")).toBe("SIM 1");
	});
});

/**
 * The whole `MMModemState` space reaches this module now that the wire schema
 * carries it, so every token must render as itself — a state with no label key
 * would render a blank badge on a working modem.
 */
describe("the full ModemManager state space renders", () => {
	const MM_STATES = [
		"failed",
		"unknown",
		"initializing",
		"locked",
		"disabled",
		"disabling",
		"enabling",
		"enabled",
		"searching",
		"registered",
		"disconnecting",
		"connecting",
		"connected",
		"scanning",
	] as const;

	it.each(MM_STATES)(
		"%s resolves to a row state with copy and a tone",
		(mm) => {
			const state = resolveRowState(
				modem({
					status: {
						connection: mm,
						signal: 0,
						roaming: false,
						network_type: "",
					},
				}),
				"mm-managed",
			);
			expect(state).toBe(mm === "locked" ? "locked" : mm);
			expect(stateLabelKey(state)).toMatch(/^network\./);
			expect(stateTone(state)).toBeTruthy();
		},
	);

	it("no two MM states read the same word", () => {
		const keys = MM_STATES.map((s) => stateLabelKey(s));
		expect(new Set(keys).size).toBe(MM_STATES.length);
	});
});

/**
 * The operator's own words: "the modems should appear in cellular even if they
 * don't have SIM cards". A SIM-less modem is a ROW with an honest state, never
 * an absence.
 */
describe("a modem with no SIM is a row, not an absence", () => {
	const simless = modem({
		name: "SIMCOM_SIM7600G-H",
		no_sim: true,
		status: {
			connection: "failed",
			signal: 0,
			roaming: false,
			network_type: "",
		},
	});

	it("renders as `no-sim`, with its hardware name as the headline", () => {
		expect(resolveRowState(simless, "mm-managed")).toBe("no-sim");
		expect(primaryLabel(simless, "4")).toBe("SIMCOM_SIM7600G-H");
	});

	it("keeps its controls, disabled with the no-SIM reason", () => {
		expect(bondDisabledReasonKey(simless, "mm-managed", "no-sim", false)).toBe(
			"network.view.noSimBond",
		);
		expect(configureDisabledReasonKey("mm-managed")).toBeUndefined();
	});
});

/**
 * Todo 46 — where a locked row's primary button SENDS the operator.
 *
 * The distinction under test is the one ModemManager itself draws: PIN1/PUK1
 * gate registration, PIN2/PUK2 gate only the Fixed-Dialling-Number list. Get it
 * backwards and either a dead config form is offered for an unusable radio, or
 * a perfectly working modem's settings vanish behind a PIN prompt.
 */
describe("cellular-row — SIM-lock routing (todo 46)", () => {
	const locked = (required: string) =>
		modem({ sim_lock: { required, remainingAttempts: 3 } } as Partial<Modem>);

	it("reads the outstanding lock back, and only for real lock tokens", () => {
		expect(activeSimLock(locked("sim-pin"))).toBe("sim-pin");
		expect(activeSimLock(locked("sim-pin2"))).toBe("sim-pin2");
		expect(activeSimLock(locked("sim-puk"))).toBe("sim-puk");
		expect(activeSimLock(locked("sim-puk2"))).toBe("sim-puk2");
		expect(activeSimLock(modem())).toBeUndefined();
		expect(activeSimLock(locked("none"))).toBeUndefined();
		expect(activeSimLock(locked("unknown-future-token"))).toBeUndefined();
	});

	it("counts PIN1/PUK1 as blocking and the `2` variants as NOT blocking", () => {
		expect(isBlockingSimLock("sim-pin")).toBe(true);
		expect(isBlockingSimLock("sim-puk")).toBe(true);
		// MM: "we don't care about SIM-PIN2/SIM-PUK2 since the device is
		// operational without it" — such a modem registers and carries data.
		expect(isBlockingSimLock("sim-pin2")).toBe(false);
		expect(isBlockingSimLock("sim-puk2")).toBe(false);
		expect(isBlockingSimLock(undefined)).toBe(false);
	});

	it("sends a BLOCKING lock to unlock, so the button never opens a dead form", () => {
		expect(resolveRowAction(locked("sim-pin"), "mm-managed")).toBe("unlock");
		expect(resolveRowAction(locked("sim-puk"), "mm-managed")).toBe("unlock");
	});

	it("leaves a NON-BLOCKING lock on configure — the modem still works", () => {
		expect(resolveRowAction(locked("sim-pin2"), "mm-managed")).toBe(
			"configure",
		);
		expect(resolveRowAction(locked("sim-puk2"), "mm-managed")).toBe(
			"configure",
		);
	});

	it("leaves an unlocked modem on configure", () => {
		expect(resolveRowAction(modem(), "mm-managed")).toBe("configure");
	});

	it("never offers unlock on a device this stack cannot drive", () => {
		// Their control is disabled-with-reason and opens nothing; relabelling it
		// would promise an unlock flow that could never run.
		expect(resolveRowAction(locked("sim-pin"), "router-ethernet")).toBe(
			"configure",
		);
		expect(resolveRowAction(locked("sim-pin"), "unmanaged")).toBe("configure");
	});

	it("still renders every lock token as the one `locked` STATE", () => {
		// With no radio state reported there is nothing for the lock to speak
		// over, so all four collapse to the single badge. Routing splits them;
		// the badge deliberately does not.
		for (const token of ["sim-pin", "sim-pin2", "sim-puk", "sim-puk2"]) {
			expect(resolveRowState(locked(token), "mm-managed")).toBe("locked");
		}
	});
});

/**
 * Todo 49 — the bench Quectel RM530N-GL, captured live from `mmcli -K -m 2`.
 *
 * Every value below is a REAL reading off the board, not an invention: 81%
 * signal, `searching`, a non-blocking `sim-pin2`, packet service `detached`,
 * and an explicit `no-cells-in-location-area` rejection from an LTE cell of
 * operator `999999`. The UI reported this modem as "SIM locked" with no stated
 * reason, and an operator reasonably concluded the hardware had failed.
 */
const QUECTEL_SEARCHING: Modem = {
	ifname: "wwan0",
	name: "RM530N-GL - 16855",
	model: "RM530N-GL",
	network_type: { supported: ["4g3g"], active: "4g3g" },
	status: {
		connection: "searching",
		signal: 81,
		roaming: false,
		network: "TIGO",
		network_type: "",
	},
	sim_lock: { required: "sim-pin2", remainingAttempts: 3 },
	packet_service_state: "detached",
	registration_rejection: {
		error: "no-cells-in-location-area",
		access_technology: "lte",
		operator_id: "999999",
	},
} as Modem;

describe("a searching modem reports its REAL signal, not zero", () => {
	it("keeps the live 81% reading at full strength", () => {
		expect(QUECTEL_SEARCHING.status?.signal).toBe(81);
		expect(resolveSignalTier(QUECTEL_SEARCHING.status?.signal)).toBe("high");
	});

	it("does not let a NON-blocking lock overwrite the radio's own state", () => {
		expect(resolveRowState(QUECTEL_SEARCHING, "mm-managed")).toBe("searching");
	});

	it("still lets a BLOCKING lock speak over the radio state", () => {
		const pinLocked = {
			...QUECTEL_SEARCHING,
			sim_lock: { required: "sim-pin" },
		} as Modem;
		expect(resolveRowState(pinLocked, "mm-managed")).toBe("locked");
	});

	it("keeps the primary action on configure, matching the state it now shows", () => {
		expect(resolveRowAction(QUECTEL_SEARCHING, "mm-managed")).toBe("configure");
	});
});

describe("registrationRejectionKey", () => {
	it("names the live board's actual rejection", () => {
		expect(registrationRejectionKey(QUECTEL_SEARCHING)).toBe(
			"network.cellular.rejection.noCells",
		);
	});

	it.each([
		["plmn-not-allowed", "network.cellular.rejection.plmnNotAllowed"],
		[
			"roaming-not-allowed-in-location-area",
			"network.cellular.rejection.roamingNotAllowed",
		],
		["gprs-not-allowed", "network.cellular.rejection.dataNotAllowed"],
		["imsi-unknown-in-hlr", "network.cellular.rejection.simUnknown"],
		["illegal-me", "network.cellular.rejection.deviceRefused"],
		["congestion", "network.cellular.rejection.congestion"],
	])("%s -> %s", (error, key) => {
		expect(
			registrationRejectionKey(modem({ registration_rejection: { error } })),
		).toBe(key);
	});

	it("an unknown rejection token resolves to generic copy, NEVER to the token", () => {
		const key = registrationRejectionKey(
			modem({ registration_rejection: { error: "some-future-reject" } }),
		);
		expect(key).toBe("network.cellular.rejection.unknown");
		expect(key).not.toContain("some-future-reject");
	});

	it("names a detached packet service once the radio claims to be registered", () => {
		const m = modem({
			packet_service_state: "detached",
			status: {
				connection: "registered",
				signal: 70,
				roaming: false,
				network_type: "4G",
			},
		});
		expect(registrationRejectionKey(m)).toBe(
			"network.cellular.rejection.packetDetached",
		);
	});

	it("stays silent about a detached packet service while still searching", () => {
		// Detached IS the expected state mid-search; naming it there would cry
		// fault on every ordinary registration.
		const m = modem({
			packet_service_state: "detached",
			status: {
				connection: "searching",
				signal: 70,
				roaming: false,
				network_type: "4G",
			},
		});
		expect(registrationRejectionKey(m)).toBeUndefined();
	});

	it("claims nothing when the device reported nothing", () => {
		expect(registrationRejectionKey(modem())).toBeUndefined();
	});

	it("prefers the network's stated reason over the inferred one", () => {
		expect(registrationRejectionKey(QUECTEL_SEARCHING)).toBe(
			"network.cellular.rejection.noCells",
		);
	});
});

describe("the rejection note LEADS the row's explanation lines", () => {
	it("puts the stated reason above the bonding consequence", () => {
		expect(
			rowNoteKeys({
				rejection: "network.cellular.rejection.noCells",
				bond: "network.cellular.bond.noAddress",
			}),
		).toEqual([
			"network.cellular.rejection.noCells",
			"network.cellular.bond.noAddress",
		]);
	});

	it("drops out entirely when there is no rejection to state", () => {
		expect(
			rowNoteKeys({
				rejection: undefined,
				bond: "network.cellular.bond.noAddress",
			}),
		).toEqual(["network.cellular.bond.noAddress"]);
	});
});

describe("isRoamingActive — a billing fact, read from the right field", () => {
	it("is true when the modem itself reports it is roaming", () => {
		expect(
			isRoamingActive(
				modem({
					status: {
						connection: "connected",
						roaming: true,
						signal: 61,
						network_type: "5G",
					},
				}),
			),
		).toBe(true);
	});

	it("is false when the modem reports it is on its home network", () => {
		expect(
			isRoamingActive(
				modem({
					status: {
						connection: "connected",
						roaming: false,
						signal: 61,
						network_type: "5G",
					},
				}),
			),
		).toBe(false);
	});

	it("reads status.roaming, NOT the config.roaming permission", () => {
		// A modem ALLOWED to roam that is sitting on its home network is not
		// roaming. Badging it would report the operator's own setting back to them.
		expect(
			isRoamingActive(
				modem({
					config: {
						apn: "internet",
						username: "",
						password: "",
						roaming: true,
						network: "",
					},
					status: {
						connection: "connected",
						roaming: false,
						signal: 61,
						network_type: "5G",
					},
				}),
			),
		).toBe(false);
	});

	it("is false for a row that reports no radio status at all", () => {
		// Every router-ethernet dongle. No status block means this build cannot
		// vouch for an answer, so it draws no badge rather than claiming "home".
		expect(isRoamingActive(modem({ device_class: "router-ethernet" }))).toBe(
			false,
		);
	});
});

/**
 * The OPTIMISTIC row (backend todo 18). It arrives with an
 * `availability_reason` and NOTHING else — no status block, no device class —
 * which is exactly the shape every other rule here treats as unreadable, so
 * each assertion below is about it NOT falling through to a generic verdict.
 */
describe("a provisional 'modem detected' row", () => {
	const provisional = modem({
		availability_reason: "modem_initializing",
	} as Partial<Modem>);

	it("resolves to the initializing state, not to unknown", () => {
		expect(resolveRowState(provisional, "mm-managed")).toBe("initializing");
		expect(stateTone("initializing")).toBe("pending");
		expect(stateLabelKey("initializing")).toMatch(/^network\./);
	});

	it("explains itself with its OWN sentence, never the generic one", () => {
		const key = availabilityReasonKey("modem_initializing");
		expect(key).toBe("network.cellular.reason.initializing");
		expect(key).not.toBe("network.cellular.reason.unknown");
	});

	it("outranks the router-ethernet gate — it carries no class to be gated on", () => {
		expect(resolveRowState(provisional, "router-ethernet")).toBe(
			"initializing",
		);
	});

	it("a REAL status still wins: the row stops waiting once something observes it", () => {
		const observed = modem({
			availability_reason: "modem_initializing",
			status: {
				connection: "connected",
				signal: 61,
				roaming: false,
				network_type: "4G",
			},
		} as Partial<Modem>);
		expect(resolveRowState(observed, "mm-managed")).toBe("connected");
	});
});
