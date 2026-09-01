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
	sortModemEntries,
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

	it.each(["sim-pin", "sim-puk"] as const)(
		"%s renders the locked state",
		(required) => {
			const m = modem({ sim_lock: { required } });
			expect(resolveRowState(m, "mm-managed")).toBe("locked");
		},
	);

	it.each(["sim-pin2", "sim-puk2"] as const)(
		"%s is NOT surfaced — it gates only the SIM's FDN list, which this product has no way to reach",
		(required) => {
			const m = modem({ sim_lock: { required } });
			expect(resolveRowState(m, "mm-managed")).toBe("unknown");
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
		["router-up", "ready"],
		["registered", "ready"],
		["connecting", "pending"],
		["disconnecting", "pending"],
		["searching", "pending"],
		["scanning", "pending"],
		["enabled", "pending"],
		["enabling", "pending"],
		["disabling", "pending"],
		["initializing", "pending"],
		["router-acquiring", "pending"],
		["locked", "attention"],
		["no-sim", "attention"],
		["failed", "error"],
		["router-down", "error"],
		["disabled", "idle"],
		["unknown", "idle"],
	] as const)("%s tone is %s", (state, tone) => {
		expect(stateTone(state)).toBe(tone);
	});
});

/**
 * A ROUTER DONGLE'S "UP" IS A LINK, AND THE ROW MUST NOT READ IT AS A PATH.
 *
 * `router-up` describes the USB-Ethernet link the dongle presents to the board.
 * It is the only thing this stack can observe about the device, and it stops at
 * layer 2 — the cellular service behind it is exactly what `router-ethernet`
 * means the device cannot reach. Rendered as a bare green "Up" it read as "this
 * is working", which is why the bench's four SIM-less dongles each showed `Up`
 * next to `No SIM`: two pills that cannot both be true under that reading.
 *
 * So the state must be separable from a genuinely-carrying `connected` on every
 * channel the row has — WORD, and the colour register that reinforces it — and
 * it must read the same whether or not a SIM is present, because the SIM is not
 * what it reports on.
 */
describe("the router link-state badge names the LINK, not the connection", () => {
	const routerDongle = (routerAdmin?: Record<string, unknown>): Modem =>
		modem({
			ifname: "enx0c5b8f279a64",
			device_class: "router-ethernet",
			availability_reason: "router_direct",
			...(routerAdmin === undefined
				? {}
				: { router_admin: routerAdmin as never }),
		});

	it("does not borrow the netns veth row's key — that is a different link", () => {
		expect(stateLabelKey("router-up")).toBe(
			"network.cellular.state.routerLinkUp",
		);
		expect(stateLabelKey("router-up")).not.toBe("network.dongle.stateUp");
	});

	it("is distinct from `connected` in BOTH word and colour register", () => {
		expect(stateLabelKey("router-up")).not.toBe(stateLabelKey("connected"));
		expect(stateTone("router-up")).not.toBe(stateTone("connected"));
	});

	it("is never drawn in the register the BOND is drawn in", () => {
		expect(stateTone("router-up")).not.toBe("live");
	});

	it("is not pessimistic either — a good local link is not a fault", () => {
		expect(stateTone("router-up")).not.toBe("error");
		expect(stateTone("router-up")).not.toBe("attention");
		expect(stateTone("router-up")).toBe(stateTone("registered"));
	});

	// The SIM is a fact about the radio inside the dongle; the badge is a fact
	// about the wire in front of it. A SIM-less unit and a SIM-holding one must
	// therefore report the SAME link state — the `No SIM` pill beside it is what
	// carries the difference, and collapsing the two into one badge is what made
	// the row contradict itself in the first place.
	it.each([
		["no SIM", { admin_url: "http://192.168.8.1", sim: "absent" }],
		["a SIM", { admin_url: "http://192.168.8.1", sim: "present" }],
	] as const)("reads identically with %s in the dongle", (_label, admin) => {
		const state = resolveRowState(routerDongle(admin), "router-ethernet");
		expect(state).toBe("router-up");
		expect(stateLabelKey(state)).toBe("network.cellular.state.routerLinkUp");
		expect(stateTone(state)).toBe("ready");
	});
});

/**
 * A REGISTERED RADIO IS RESTING, NOT WORKING — AND IT IS NOT IN THE BOND.
 *
 * The fixture is this bench's Quectel RM530N-GL as `mmcli -m 44` reported it on
 * 2026-08-18: attached to Movistar on its HOME network over LTE at 86 %, packet
 * service attached, no rejection, and a non-blocking `sim-pin2` outstanding.
 * Nothing about it is in flight and nothing about it is broken — which is the
 * whole point, because it used to draw the amber "still working on it" register
 * behind an `Hourglass`.
 */
describe("registered is its own register (board fixture)", () => {
	const rm530n = modem({
		ifname: "wwan2",
		name: "RM530N-GL - 16855",
		device_class: "usb",
		sim_lock: { required: "sim-pin2" },
		packet_service_state: "attached",
		status: {
			connection: "registered",
			signal: 86,
			roaming: false,
			network: "Movistar",
			network_type: "lte",
		},
	} as Partial<Modem>);

	it("resolves to `registered` — the non-blocking PIN2 does not speak over it", () => {
		expect(resolveRowState(rm530n, "mm-managed")).toBe("registered");
	});

	it("is NOT drawn in the transitional register", () => {
		const tone = stateTone("registered");

		expect(tone).toBe("ready");
		for (const inFlight of ["searching", "connecting", "scanning"] as const) {
			expect(tone).not.toBe(stateTone(inFlight));
		}
	});

	// The other half of the fix, and the reason `ready` had to exist rather than
	// `registered` simply being promoted to `live`: this modem holds no address,
	// so the row itself refuses the bond. A carrying-data colour above that
	// sentence would make the row contradict itself.
	it("is NOT drawn as bonded, because the row refuses the bond", () => {
		expect(stateTone("registered")).not.toBe(stateTone("connected"));
		expect(
			bondDisabledReasonKey(rm530n, "mm-managed", "registered", false),
		).toBe("network.cellular.bond.noAddress");
	});

	it("claims no fault — an attached packet service explains nothing", () => {
		expect(registrationRejectionKey(rm530n)).toBeUndefined();
	});

	// A `registered` radio whose packet service is DETACHED is a different fact,
	// and `DATA_EXPECTED_STATES` already names it. The calm tone must not swallow
	// that line.
	it("still names a detached packet service on the same state", () => {
		const detached = modem({
			...rm530n,
			packet_service_state: "detached",
		} as Partial<Modem>);

		expect(registrationRejectionKey(detached)).toBe(
			"network.cellular.rejection.packetDetached",
		);
		expect(stateTone("registered")).toBe("ready");
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
		["router-ethernet", "network.cellular.reason.routerControlsUnverified"],
		["unmanaged", "network.cellular.config.unmanaged"],
	] as const)("%s is disabled with a reason", (band, key) => {
		expect(configureDisabledReasonKey(band)).toBe(key);
	});

	/**
	 * WHY IT IS REFUSED IS THE QUESTION, AND EVERY REFUSAL USED TO ANSWER IT
	 * THE SAME WAY.
	 *
	 * Configure is refused when no write to this dongle has been PROVEN to
	 * land, and offered when one has. Both rows are `router-ethernet`, both run
	 * their own router, and while the refusal reused the generic availability
	 * sentence the two rows differed by nothing an operator could read: a
	 * working Huawei and a refused ZTE both said "manages this connection
	 * itself". The reason must therefore be its own key — distinct from every
	 * other reason on this surface, so no future collapse can re-merge them.
	 */
	it("names the unverified-write refusal in its own words", () => {
		const key = configureDisabledReasonKey("router-ethernet");

		expect(key).toBe("network.cellular.reason.routerControlsUnverified");
		expect(key).not.toBe(availabilityReasonKey("router_managed"));
		expect(key).not.toBe(availabilityReasonKey("router_direct"));
		expect(key).not.toBe(configureDisabledReasonKey("unmanaged"));
		expect(key).not.toBe("network.cellular.reason.unknown");
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
			"network.cellular.reason.routerControlsUnverified",
		);
	});

	/**
	 * A LOCK IS NOT A DEVICE LIMITATION, AND IT MUST NOT CLOSE THE DOOR.
	 *
	 * `gateRouterAdminByLock` withholds `router_admin.controls` while the
	 * dongle's own login stands, which is byte-identical on the wire to "no
	 * write was ever proven". Read that way, Configure was disabled on exactly
	 * the devices whose dialog now carries the login form — so the operator was
	 * refused entry to the one surface that could fix the state, and the row
	 * additionally blamed the hardware for it.
	 */
	function locked(state: string): Modem {
		return {
			router_admin: { admin_url: "http://192.168.8.1", reachable: true },
			lock_state: state,
			lock_detail: { credential_configured: false },
		} as unknown as Modem;
	}

	it.each(["locked", "auth-failed", "locked-out"])(
		"a %s dongle stays configurable — the dialog carries its login",
		(state) => {
			expect(
				configureDisabledReasonKey("router-ethernet", locked(state)),
			).toBeUndefined();
		},
	);

	it("…but an `open` dongle with no proven write is still refused", () => {
		// The lock exemption must not become a blanket one: `open` and `unlocked`
		// are the states the device DOES serve its control block in, so absence
		// there really is "nothing here is provably settable".
		expect(configureDisabledReasonKey("router-ethernet", locked("open"))).toBe(
			"network.cellular.reason.routerControlsUnverified",
		);
		expect(
			configureDisabledReasonKey("router-ethernet", locked("unlocked")),
		).toBe("network.cellular.reason.routerControlsUnverified");
	});

	it("…and a dongle with no login surface at all is unchanged", () => {
		const noLock = {
			router_admin: { admin_url: "http://192.168.0.1", reachable: true },
		} as unknown as Modem;
		expect(configureDisabledReasonKey("router-ethernet", noLock)).toBe(
			"network.cellular.reason.routerControlsUnverified",
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

	/**
	 * The unverified-write refusal already contains the generic sentence's
	 * content — it names why THIS dongle offers nothing and still points at its
	 * own web interface — so the two are not two facts. Printing both restates
	 * half of one under the other and grows the row back towards the wall the
	 * density pass removed, which is the only reason splitting the keys is safe.
	 */
	it("drops a generic line the specific one already covers", () => {
		expect(
			rowNoteKeys({
				availability: "network.cellular.reason.routerManaged",
				configure: "network.cellular.reason.routerControlsUnverified",
			}),
		).toEqual(["network.cellular.reason.routerControlsUnverified"]);
	});

	it("keeps the generic line when nothing supersedes it", () => {
		expect(
			rowNoteKeys({ availability: "network.cellular.reason.routerManaged" }),
		).toEqual(["network.cellular.reason.routerManaged"]);
	});

	it("supersedes only the named key, never a neighbouring reason", () => {
		expect(
			rowNoteKeys({
				availability: "network.cellular.reason.routerManaged",
				bond: "network.cellular.bond.routerManagedLink",
				configure: "network.cellular.reason.routerControlsUnverified",
			}),
		).toEqual([
			"network.cellular.bond.routerManagedLink",
			"network.cellular.reason.routerControlsUnverified",
		]);
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

	it("reads back only the locks this UI surfaces at all", () => {
		expect(activeSimLock(locked("sim-pin"))).toBe("sim-pin");
		expect(activeSimLock(locked("sim-puk"))).toBe("sim-puk");
		expect(activeSimLock(modem())).toBeUndefined();
		expect(activeSimLock(locked("none"))).toBeUndefined();
		expect(activeSimLock(locked("unknown-future-token"))).toBeUndefined();
	});

	it("answers `undefined` for the `2` variants — they are not surfaced", () => {
		// A product decision, not a reading: PIN2/PUK2 gate only the SIM's
		// Fixed-Dialling-Number list, and this product has no calls or contacts
		// surface to reach it from. The wire still carries the token.
		expect(activeSimLock(locked("sim-pin2"))).toBeUndefined();
		expect(activeSimLock(locked("sim-puk2"))).toBeUndefined();
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

	it("renders a BLOCKING lock as the `locked` STATE", () => {
		for (const token of ["sim-pin", "sim-puk"]) {
			expect(resolveRowState(locked(token), "mm-managed")).toBe("locked");
		}
	});

	it("never renders a `2` variant as `locked`, even with no radio state", () => {
		// The old rule let a `2` variant claim `locked` whenever the radio had
		// reported nothing. "Nothing was reported" is `unknown`; a lock this
		// product cannot act on may not stand in for it.
		expect(resolveRowState(locked("sim-pin2"), "mm-managed")).toBe("unknown");
		expect(resolveRowState(locked("sim-puk2"), "mm-managed")).toBe("unknown");
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

/**
 * The same bench Quectel once it REGISTERS, which is how it reads on the board
 * today — and the state this row must show ALONE.
 *
 * `sim-pin2` was previously disclosed twice over: it forced `locked` whenever no
 * connection was reported, and otherwise rode along as a second "SIM locked"
 * pill beside the true state. Both are gone. There is no PIN2 surface left in
 * this UI, so every derivation an operator can see must resolve as if the token
 * were absent.
 */
describe("a `sim-pin2`-only modem is indistinguishable from an unlocked one", () => {
	const QUECTEL_REGISTERED = {
		...QUECTEL_SEARCHING,
		status: { ...QUECTEL_SEARCHING.status, connection: "registered" },
	} as Modem;

	const UNLOCKED = { ...QUECTEL_REGISTERED, sim_lock: undefined } as Modem;

	it("renders its REAL state, in the resting `ready` register", () => {
		expect(resolveRowState(QUECTEL_REGISTERED, "mm-managed")).toBe(
			"registered",
		);
		expect(stateTone(resolveRowState(QUECTEL_REGISTERED, "mm-managed"))).toBe(
			"ready",
		);
	});

	it("discloses no lock anywhere a row could render one", () => {
		expect(activeSimLock(QUECTEL_REGISTERED)).toBeUndefined();
		expect(isBlockingSimLock(activeSimLock(QUECTEL_REGISTERED))).toBe(false);
		expect(resolveRowAction(QUECTEL_REGISTERED, "mm-managed")).toBe(
			"configure",
		);
	});

	it("derives exactly what the same modem with NO lock derives", () => {
		for (const band of ["mm-managed"] as const) {
			expect(resolveRowState(QUECTEL_REGISTERED, band)).toBe(
				resolveRowState(UNLOCKED, band),
			);
			expect(resolveRowAction(QUECTEL_REGISTERED, band)).toBe(
				resolveRowAction(UNLOCKED, band),
			);
		}
		expect(activeSimLock(QUECTEL_REGISTERED)).toBe(activeSimLock(UNLOCKED));
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

	it("settles into a quiet undriveable state after authoritative discovery misses it", () => {
		const undriveable = modem({
			availability_reason: "undriveable",
		} as Partial<Modem>);

		expect(resolveRowState(undriveable, "mm-managed")).toBe("undriveable");
		expect(stateTone("undriveable")).toBe("attention");
		expect(availabilityReasonKey("undriveable")).toBe(
			"network.cellular.reason.undriveable",
		);
	});
});

/**
 * The row order. Every wire id is `String(number)`, so `Object.entries` already
 * hands the renderer the roster in ASCENDING NUMERIC ID order — emission order
 * cannot leak, and a fixture built to prove it would be vacuous. What is NOT
 * stable is the id itself: mmcli re-issues it on a replug and renumbers the
 * whole roster on a restart. Every case below therefore models a roster already
 * in ascending-id order whose ids no longer describe the same ports.
 */
describe("sortModemEntries — the order is the hardware's, not the wire id's", () => {
	function anchored(port: string, over: Partial<Modem> = {}): Modem {
		return modem({ stable_key: `pci-0000:00:14.0-usb-0:${port}`, ...over });
	}

	const ports = (entries: readonly (readonly [string, Modem])[]): string[] =>
		entries.map(([, m]) => m.stable_key ?? "");

	const ids = (entries: readonly (readonly [string, Modem])[]): string[] =>
		entries.map(([id]) => id);

	it("Given ascending ids that descend by PORT, Then the port decides", () => {
		const roster: [string, Modem][] = [
			["2", anchored("3")],
			["5", anchored("2")],
			["7", anchored("1")],
		];

		expect(ids(sortModemEntries(roster))).toEqual(["7", "5", "2"]);
	});

	it("Given a replug hands one device a FRESH higher index, Then its row stays put", () => {
		const before = sortModemEntries([
			["11", anchored("1")],
			["12", anchored("2")],
			["13", anchored("3")],
		]);

		// mmcli drops the middle device and re-adds it at the end of the index
		// space, so ascending-id order alone would move it to the bottom.
		const after = sortModemEntries([
			["11", anchored("1")],
			["13", anchored("3")],
			["14", anchored("2")],
		]);

		expect(ports(after)).toEqual(ports(before));
	});

	it("Given an MM restart renumbers every id, Then the ports keep the order", () => {
		const before = sortModemEntries(
			["1", "2", "3", "4"].map(
				(port, i) => [`${11 + i}`, anchored(port)] as [string, Modem],
			),
		);
		// 11,13,14,15 -> 0,1,2,3, and MM re-probed the ports in the other order.
		const after = sortModemEntries(
			["4", "3", "2", "1"].map(
				(port, i) => [`${i}`, anchored(port)] as [string, Modem],
			),
		);

		expect(ports(after)).toEqual(ports(before));
	});

	it("Given the bench twins share ONE factory MAC, Then their ports separate them", () => {
		// Board fact: two physically distinct HiLink units publish one MAC, so
		// systemd names only one predictably and the loser falls back to `eth1`.
		const twinA: [string, Modem] = [
			"1001",
			anchored("1.4.1", { ifname: "enx0c5b8f279a64" }),
		];
		const twinB: [string, Modem] = [
			"1002",
			anchored("1.4.3", { ifname: "eth1" }),
		];
		const before = sortModemEntries([twinA, twinB]);

		// They rename against each other on replug. The NAME is not the key.
		const renamedA: [string, Modem] = [
			"1001",
			anchored("1.4.1", { ifname: "eth1" }),
		];
		const renamedB: [string, Modem] = [
			"1002",
			anchored("1.4.3", { ifname: "enx0c5b8f279a64" }),
		];

		expect(ids(sortModemEntries([renamedB, renamedA]))).toEqual(ids(before));
		expect(ids(before)).toEqual(["1001", "1002"]);
	});

	it("Given no ID_PATH ever resolved, Then the id is the honest floor", () => {
		const roster: [string, Modem][] = [
			["9", modem()],
			["10", modem()],
			["1", modem()],
		];

		// Code-unit order, so "10" precedes "9" — deterministic, never localized.
		expect(ids(sortModemEntries(roster))).toEqual(["1", "10", "9"]);
	});

	it("Given a mixed roster, Then anchored rows lead and unanchored ones follow", () => {
		const roster: [string, Modem][] = [
			["3", modem()],
			["4", anchored("9")],
			["1", modem()],
		];

		expect(ids(sortModemEntries(roster))).toEqual(["4", "1", "3"]);
	});

	it("Given a row gains its anchor, Then it moves ONCE and never again", () => {
		const settling = sortModemEntries([
			["2", modem()],
			["1", anchored("1")],
		]);
		const settled = sortModemEntries([
			["2", anchored("2")],
			["1", anchored("1")],
		]);

		expect(ids(settling)).toEqual(["1", "2"]);
		expect(ids(settled)).toEqual(["1", "2"]);
		expect(ids(sortModemEntries(settled))).toEqual(ids(settled));
	});

	it("never mutates its input — the caller hands over a $derived array", () => {
		const roster: [string, Modem][] = [
			["7", anchored("3")],
			["2", anchored("1")],
		];
		const snapshot = [...roster];

		sortModemEntries(roster);

		expect(roster).toEqual(snapshot);
	});

	it("an empty or whitespace stable_key is NOT an anchor", () => {
		const roster: [string, Modem][] = [
			["2", modem({ stable_key: "   " } as Partial<Modem>)],
			["1", modem({ stable_key: "" } as Partial<Modem>)],
		];

		expect(ids(sortModemEntries(roster))).toEqual(["1", "2"]);
	});
});
