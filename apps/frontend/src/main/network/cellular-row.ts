/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * CellularSection row derivation — pure, rune-free.
 *
 * The Network destination's cellular list has to render THREE structurally
 * different kinds of device from ONE `modems` payload, and the honest floor is
 * that every one of them gets a row:
 *
 *   - an MM-managed radio (`usb` / `pcie-mhi` / `pcie-mtk` / `soc-qrtr`), which
 *     reports a full `status` block and is configurable from here;
 *   - a `router-ethernet` dongle running its own embedded router, which reports
 *     NO radio status at all (the backend deliberately omits it rather than
 *     fabricating a zeroed one — see `modem-wire-adapters.ts` `fromRouterView`)
 *     and carries an `availability_reason` explaining why its controls are dead;
 *   - anything else — a transport this build does not recognise — which is
 *     rendered as an honest generic row rather than dropped.
 *
 * NOTHING IS EVER HIDDEN. A device this UI cannot control is DIMMED and its
 * controls are DISABLED WITH A VISIBLE REASON, never removed from the list and
 * never left as a bare dead control. That is the same house rule the capability
 * surfaces follow, and it is what stops "my modem disappeared" being the way an
 * operator finds out their dongle is router-managed.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A MACHINE TOKEN IS NEVER RENDERED RAW
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `availability_reason` is a wire-stable token (`router_managed` /
 * `dongle_acquiring` / `dongle_down`), exactly like the config-change reason
 * tokens: it is keyed to operator copy here and a token this build does not know
 * resolves to a generic honest sentence rather than leaking an identifier to an
 * operator with no console. Every resolver below therefore returns an i18n
 * DOT-PATH KEY, not a string — the component resolves it through
 * `resolveMessageKey`, and this module stays pure and locale-free.
 */
import { isSimlessForBond } from "@ceraui/rpc";
import type { ConnectionStatus, Modem } from "@ceraui/rpc/schemas";

import {
	deriveLockView,
	lockWithholdsCapabilities,
} from "$lib/modem/lock-state";

/**
 * Does this device report an empty SIM slot, whichever class it belongs to?
 *
 * The two modem classes publish that same fact through DIFFERENT wire fields —
 * ModemManager's `no_sim` for a directly-managed radio, the dongle's own admin
 * API as `router_admin.sim` for a `router-ethernet` unit — and the shared rule
 * in `@ceraui/rpc` is what keeps this row's answer identical to the DEVICE's own
 * bond gate. Reading only `no_sim` here is what left a SIM-less dongle with a
 * live "In Bond" toggle while a SIM-less modem's was forced off.
 */
export function isSimlessModem(modem: Modem): boolean {
	return isSimlessForBond({
		noSim: modem.no_sim,
		routerSim: modem.router_admin?.sim,
	});
}

/**
 * The tier/class band a row is stamped with. The vocabulary is
 * `docs/MODEM-SUPPORT-MATRIX.md`'s, verbatim: §1's tier model calls a dongle
 * ModemManager architecturally cannot control `router-ethernet`, the devices it
 * CAN control "MM-managed", and a rebrand it refuses to vouch for
 * "unmanaged/unsupported".
 */
export type ModemClassBand = "mm-managed" | "router-ethernet" | "unmanaged";

/**
 * Lifecycle state, one WORD per state on screen. Colour only ever reinforces
 * the word — a badge carries its own glyph too, per the `EthernetSection`
 * dongle-row precedent (todo 19).
 */
export type ModemRowState =
	| ConnectionStatus
	| "no-sim"
	| "router-up"
	| "router-acquiring"
	| "router-down";

/**
 * The state dot's register. `idle` is "nothing was reported", not "off".
 *
 * `ready` is the sixth, and it exists because the other five could not name the
 * state a healthy radio SITS in — attached to its network, carrying no data,
 * nothing wrong and nothing to do. See {@link STATE_TONES}.
 */
export type ModemRowTone =
	| "live"
	| "ready"
	| "pending"
	| "attention"
	| "error"
	| "idle";

/**
 * Qualitative radio strength. Deliberately NOT a percentage and deliberately
 * NOT a `data-live-value`: `BondedLinksSection` is the documented sole owner of
 * live per-link telemetry (RTT / NAK / weight / throughput) on this
 * destination, and the T20 pass removed this section's numeric signal readout
 * for exactly that reason. What survives here is a glance-level tier with a
 * WORD behind it, which duplicates no number rendered anywhere else.
 */
export type ModemSignalTier = "high" | "medium" | "low" | "none";

/** Transports the modem stack actually manages through ModemManager. */
const MM_MANAGED_CLASSES: ReadonlySet<string> = new Set([
	"usb",
	"pcie-mhi",
	"pcie-mtk",
	"soc-qrtr",
]);

/**
 * The SIM locks this UI surfaces AT ALL, which is exactly the set that stops
 * the radio REGISTERING — so a row carrying one has genuinely lost service and
 * the config form behind it is inert.
 *
 * The `2` variants are deliberately ABSENT, and that omission IS this set's
 * purpose. ModemManager refuses to mark either of them a lock: "we don't care
 * about SIM-PIN2/SIM-PUK2 since the device is operational without it"
 * (`src/mm-iface-modem.c`), and the bench Quectel proves it, registering with
 * `lock: sim-pin2` still outstanding. PIN2 gates ONLY the SIM's
 * Fixed-Dialling-Number list — this product exposes no calls, no contacts and
 * no FDN surface anywhere, so the lock blocks nothing an operator here can
 * reach, and an unlock would not even survive a reboot (`Sim.SendPin` verifies
 * for the current UICC session only, and there is no PIN2 equivalent of
 * `EnablePin`). Surfacing it flagged a working modem as "locked" over a
 * credential with nothing behind it.
 *
 * Do NOT add either token back. That is a product decision about what this
 * device DOES, not an oversight about what ModemManager reports — the wire
 * still carries `sim-pin2` truthfully, and this UI still chooses not to render
 * it.
 */
const BLOCKING_SIM_LOCKS: ReadonlySet<string> = new Set(["sim-pin", "sim-puk"]);

/**
 * What the row's primary action should DO, which is not always "configure".
 *
 * - `configure` — no lock this UI surfaces. The config dialog is the honest
 *   destination, including for a modem carrying an unsurfaced `sim-pin2`, which
 *   registers and streams normally.
 * - `unlock` — a blocking lock. Registration is impossible until it clears, so
 *   the config form would be a dead end and the button says `unlock` instead.
 */
export type ModemRowAction = "configure" | "unlock";

/**
 * `availability_reason` token → operator copy. `dongle_acquiring` /
 * `dongle_down` REUSE the `EthernetSection` dongle row's existing sentences on
 * purpose: it is the same physical device seen from a second surface, so the
 * two must not describe it differently (and it costs no new translation).
 */
const AVAILABILITY_REASON_KEYS: Readonly<Record<string, string>> = {
	router_managed: "network.cellular.reason.routerManaged",
	// A CLASSIFIED dongle — one this stack reaches directly, with no netns layer
	// between — resolves to the SAME sentence as a netns-claimed one, because the
	// fact is identical: the dongle owns its own configuration. Sharing the key
	// is also what lets {@link rowNoteKeys} collapse it against the Configure
	// reason, so the row states it once instead of twice.
	router_direct: "network.cellular.reason.routerManaged",
	dongle_acquiring: "network.dongle.blockedAcquiring",
	dongle_down: "network.dongle.blockedDown",
	// The OPTIMISTIC row: udev announced a cellular-class USB device and no
	// modem service has described it yet. It is the only token here that says
	// "wait", so its sentence must promise nothing about the device beyond its
	// presence — every other fact is genuinely unknown at this point.
	modem_initializing: "network.cellular.reason.initializing",
};

/**
 * The token whose row is a device we have only SEEN, not observed.
 *
 * It gets its own constant because it is read twice — once for its explanatory
 * sentence and once by {@link resolveRowState}, which must not let the row fall
 * through to `unknown`. "Unknown" is the verdict for a device whose transport we
 * could not read; this device's state is known and is `initializing`.
 */
const PROVISIONAL_REASON = "modem_initializing";

/**
 * Availability tokens for a dongle whose OWN interface carries the bonded
 * traffic. A netns-claimed dongle is the opposite case: its veth owns the
 * toggle, so its modem row must refuse one.
 */
const DIRECT_ROUTER_REASONS: ReadonlySet<string> = new Set([
	"router_direct",
	"dongle_acquiring",
]);

/**
 * ModemManager `MMNetworkError` token → operator copy.
 *
 * These are the reasons a radio with full bars never registers, and each one
 * points somewhere different: `no-cells-in-location-area` is a coverage fact
 * the operator can act on by moving, `plmn-not-allowed` and the `roaming-*`
 * pair are plan/SIM facts no amount of waiting fixes, and the `imsi-*`/`illegal-*`
 * family means the carrier refused this SIM or this IMEI outright. Collapsing
 * them into one "not connecting" is what left the bench Quectel looking broken.
 */
const REJECTION_REASON_KEYS: Readonly<Record<string, string>> = {
	"no-cells-in-location-area": "network.cellular.rejection.noCells",
	"plmn-not-allowed": "network.cellular.rejection.plmnNotAllowed",
	"location-area-not-allowed": "network.cellular.rejection.areaNotAllowed",
	"roaming-not-allowed-in-location-area":
		"network.cellular.rejection.roamingNotAllowed",
	"gprs-not-allowed": "network.cellular.rejection.dataNotAllowed",
	"gprs-and-non-gprs-not-allowed": "network.cellular.rejection.dataNotAllowed",
	"imsi-unknown-in-hlr": "network.cellular.rejection.simUnknown",
	"imsi-unknown-in-vlr": "network.cellular.rejection.simUnknown",
	"illegal-ms": "network.cellular.rejection.simRefused",
	"illegal-me": "network.cellular.rejection.deviceRefused",
	"imei-not-accepted": "network.cellular.rejection.deviceRefused",
	"network-failure": "network.cellular.rejection.networkFailure",
	congestion: "network.cellular.rejection.congestion",
};

/** States in which the radio is meant to be carrying data, so a detached packet
 * service is a fault worth naming rather than an expected intermediate. */
const DATA_EXPECTED_STATES: ReadonlySet<string> = new Set([
	"registered",
	"connected",
]);

const STATE_LABEL_KEYS: Readonly<Record<ModemRowState, string>> = {
	connected: "network.modem.connectionStatus.connected",
	connecting: "network.modem.connectionStatus.connecting",
	disconnecting: "network.modem.connectionStatus.disconnecting",
	registered: "network.modem.connectionStatus.registered",
	searching: "network.modem.connectionStatus.searching",
	scanning: "network.modem.connectionStatus.scanning",
	enabled: "network.modem.connectionStatus.enabled",
	enabling: "network.cellular.state.enabling",
	disabled: "network.cellular.state.disabled",
	disabling: "network.cellular.state.disabling",
	initializing: "network.cellular.state.initializing",
	failed: "network.modem.connectionStatus.failed",
	locked: "network.cellular.state.locked",
	"no-sim": "network.cellular.state.noSim",
	// A `router-ethernet` dongle presents itself to the board as a USB-Ethernet
	// adapter, so this state is the LOCAL wired link between the two — layer 2,
	// and nothing more. It cannot speak for the cellular service inside the
	// dongle, which this stack architecturally never reaches; the class hint
	// says the same thing at length ("the device sees it as an Ethernet
	// uplink"). A bare "Up" claims the whole path, which is why a SIM-LESS
	// dongle rendered `Up` beside `No SIM` — two pills that cannot both be true
	// under that reading. The word must therefore NAME what is up.
	//
	// That is also why it does not borrow `network.dongle.stateUp`: those keys
	// belong to the `dg<N>h` veth row in `EthernetSection`, a different link on
	// a different surface. `router-acquiring`/`router-down` stay shared — no
	// promise about connectivity is possible from either word.
	"router-up": "network.cellular.state.routerLinkUp",
	"router-acquiring": "network.dongle.stateAcquiring",
	"router-down": "network.dongle.stateDown",
	unknown: "network.cellular.state.unknown",
};

/**
 * State → dot register.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * `registered` IS NOT `pending`, AND IT IS NOT `connected` EITHER
 * ────────────────────────────────────────────────────────────────────────────
 *
 * It used to be `pending`, which drew a modem ATTACHED to its home network in
 * the same amber register, behind the same `Hourglass`, as one still `searching`
 * for a network it has not found. Those are opposite conditions, and an operator
 * reading the row said so: an hourglass on a working radio reads as "something
 * is stuck", not "this is working".
 *
 * ModemManager's own vocabulary settles it. `MM_MODEM_STATE_SEARCHING` is the
 * modem "searching for a network provider to register with" — genuinely work in
 * progress. `MM_MODEM_STATE_REGISTERED` is "registered with a network provider,
 * and data connections and messaging may be available for use" — a RESTING state
 * the radio holds indefinitely, not one it is passing through. Board-measured on
 * this bench's Quectel RM530N-GL: `state: registered` / `registration: home` /
 * `packet service state: attached` / `access tech: lte` / 86 % on Movistar, with
 * no rejection reason and nothing in flight.
 *
 * It is NOT `live` either, and that is the other half. `live` is the register
 * the BOND is drawn in, and a `registered` modem has no bearer — so its net
 * interface holds no address at all (measured on the same board, where
 * `ip -br -4 addr` lists no `wwan2`). The device's own `isBondCandidate` gates
 * on that address before anything else, so the link is not a bonding candidate,
 * and this row ALREADY says so on its note line. Painting the badge
 * phosphor-lime would make the row contradict itself: a carrying-data colour
 * above a sentence explaining that it carries none, beside a dead bond toggle.
 *
 * Hence `ready`. Each of the other five says something false about it: `pending`
 * claims work in progress, `live` claims the bond, `attention` demands an action
 * there is none to take, `error` claims a fault the network never reported, and
 * `idle` claims nothing was reported by a radio that reported everything.
 */
const STATE_TONES: Readonly<Record<ModemRowState, ModemRowTone>> = {
	connected: "live",
	connecting: "pending",
	disconnecting: "pending",
	registered: "ready",
	searching: "pending",
	scanning: "pending",
	enabled: "pending",
	enabling: "pending",
	disabling: "pending",
	initializing: "pending",
	disabled: "idle",
	failed: "error",
	locked: "attention",
	"no-sim": "attention",
	// `ready` for the same reason `registered` is, one register down: `live` is
	// the colour the BOND is drawn in, and a link-state badge reports a link,
	// never traffic. The dongle behind an up link may hold no SIM at all, so
	// phosphor-lime would put a carrying-data colour beside a `No SIM` pill —
	// the colour half of the contradiction the word half above removes. It is
	// not a claim of trouble: a good local link with nothing yet behind it is
	// precisely the resting-healthy state `ready` exists for, and whether the
	// link actually carries bonded traffic is `BondedLinksSection`'s question.
	"router-up": "ready",
	"router-acquiring": "pending",
	"router-down": "error",
	unknown: "idle",
};

const CLASS_LABEL_KEYS: Readonly<Record<ModemClassBand, string>> = {
	"mm-managed": "network.cellular.class.mmManaged",
	"router-ethernet": "network.cellular.class.routerEthernet",
	unmanaged: "network.cellular.class.unmanaged",
};

const CLASS_HINT_KEYS: Readonly<Record<ModemClassBand, string>> = {
	"mm-managed": "network.cellular.class.mmManagedHint",
	"router-ethernet": "network.cellular.class.routerEthernetHint",
	unmanaged: "network.cellular.class.unmanagedHint",
};

const SIGNAL_LABEL_KEYS: Readonly<Record<ModemSignalTier, string>> = {
	high: "network.cellular.signal.high",
	medium: "network.cellular.signal.medium",
	low: "network.cellular.signal.low",
	none: "network.cellular.signal.none",
};

/**
 * Resolve the class band.
 *
 * An ABSENT `device_class` is `mm-managed`, and that is a statement rather than
 * a default: the pre-Phase-B wire was produced exclusively by the mmcli path,
 * which lists only devices ModemManager manages. An UNRECOGNISED class is
 * `unmanaged` — this build cannot say how that transport is controlled, so it
 * says so instead of guessing at one of the two it knows.
 */
export function resolveClassBand(
	deviceClass: string | undefined,
): ModemClassBand {
	if (deviceClass === undefined) return "mm-managed";
	if (deviceClass === "router-ethernet") return "router-ethernet";
	if (MM_MANAGED_CLASSES.has(deviceClass)) return "mm-managed";
	return "unmanaged";
}

/**
 * Resolve the lifecycle state.
 *
 * Precedence is deliberate: a SIM the operator has to act on outranks whatever
 * the radio was doing, a reported `status` outranks a lifecycle inferred from
 * an availability token, and an unrecognised token resolves to `unknown` rather
 * than to the `up` it most resembles — claiming a dongle is up on the strength
 * of a token we could not read is exactly the fabrication the backend refused
 * to make when it omitted the status block.
 */
export function resolveRowState(
	modem: Modem,
	band: ModemClassBand,
): ModemRowState {
	if (modem.no_sim === true) return "no-sim";

	const lock = modem.sim_lock?.required;
	const connection = modem.status?.connection;

	// Only a lock that actually STOPS the radio may speak over the radio's own
	// reported state, and that is now the only kind this UI reports at all
	// ({@link BLOCKING_SIM_LOCKS}). A `sim-pin2`/`sim-puk2` row used to render
	// "SIM locked" while the modem was live on the air — the bench Quectel's
	// exact case: registered on its carrier, with a badge blaming a credential
	// that gates nothing this product can reach. It now renders whatever the
	// radio is genuinely doing, with no lock indication anywhere.
	if (lock !== undefined && BLOCKING_SIM_LOCKS.has(lock)) return "locked";

	if (connection !== undefined) return connection;

	// Band-agnostic ON PURPOSE, unlike the router tokens below. A provisional row
	// exists precisely because nothing has yet said WHAT this device is, so it
	// carries no `device_class` and resolves to the `mm-managed` default — the
	// one band a `router-ethernet` gate would exclude it from.
	if (modem.availability_reason === PROVISIONAL_REASON) return "initializing";

	if (band === "router-ethernet") {
		const reason = modem.availability_reason;
		if (reason === "router_managed" || reason === "router_direct")
			return "router-up";
		if (reason === "dongle_acquiring") return "router-acquiring";
		if (reason === "dongle_down") return "router-down";
	}

	return "unknown";
}

/**
 * The outstanding SIM lock, or `undefined`. `resolveRowState` collapses both
 * tokens into one `locked` state for display; the unlock routing needs to know
 * WHICH, so it reads this instead of re-testing the raw wire field. A
 * `sim-pin2`/`sim-puk2` modem answers `undefined` — this UI does not surface
 * those at all (see {@link BLOCKING_SIM_LOCKS}).
 */
export function activeSimLock(modem: Modem): string | undefined {
	const lock = modem.sim_lock?.required;
	if (lock === undefined || !BLOCKING_SIM_LOCKS.has(lock)) return undefined;
	return lock;
}

export function isBlockingSimLock(lock: string | undefined): boolean {
	return lock !== undefined && BLOCKING_SIM_LOCKS.has(lock);
}

/**
 * Is this modem roaming RIGHT NOW?
 *
 * `status.roaming` is the modem's own registration claim. `config.roaming` is
 * the operator's PERMISSION for it to roam — a modem sitting on its home network
 * with roaming allowed is not roaming, and badging it would report a setting
 * back to the person who set it. A row with no `status` block at all (every
 * `router-ethernet` dongle, by construction) says nothing either way, so it gets
 * no badge rather than a `false` this build cannot actually vouch for.
 *
 * INFORMATIONAL ONLY: nothing downstream of this reads the result to decide
 * whether the link bonds or the stream starts. Roaming is a billing fact.
 */
export function isRoamingActive(modem: Modem): boolean {
	return modem.status?.roaming === true;
}

/**
 * What the row's primary button does, and therefore what it must be LABELLED.
 *
 * A button reading "Configure" that opens a PIN prompt is the same surprise as
 * the global auto-open this replaced, so a blocking lock renames the control
 * rather than quietly repurposing it. A device this stack cannot control keeps
 * `configure` — its button is disabled with a reason and opens nothing.
 */
export function resolveRowAction(
	modem: Modem,
	band: ModemClassBand,
): ModemRowAction {
	if (band !== "mm-managed") return "configure";
	return isBlockingSimLock(activeSimLock(modem)) ? "unlock" : "configure";
}

export function stateTone(state: ModemRowState): ModemRowTone {
	return STATE_TONES[state];
}

export function stateLabelKey(state: ModemRowState): string {
	return STATE_LABEL_KEYS[state];
}

export function classLabelKey(band: ModemClassBand): string {
	return CLASS_LABEL_KEYS[band];
}

export function classHintKey(band: ModemClassBand): string {
	return CLASS_HINT_KEYS[band];
}

export function signalLabelKey(tier: ModemSignalTier): string {
	return SIGNAL_LABEL_KEYS[tier];
}

/**
 * Map an `availability_reason` token to operator copy. Absent ⇒ no line (there
 * is nothing to explain); unknown token ⇒ the generic sentence, never the token.
 */
export function availabilityReasonKey(
	reason: string | undefined,
): string | undefined {
	if (reason === undefined || reason.trim() === "") return undefined;
	return AVAILABILITY_REASON_KEYS[reason] ?? "network.cellular.reason.unknown";
}

/**
 * Qualitative strength tier. Absent/non-finite ⇒ `undefined`, i.e. NO glyph —
 * a device that reported no radio status must not render an empty meter, which
 * reads as "no signal" on a dongle that is carrying traffic.
 */
export function resolveSignalTier(
	signal: number | undefined,
): ModemSignalTier | undefined {
	if (signal === undefined || !Number.isFinite(signal)) return undefined;
	if (signal >= 70) return "high";
	if (signal >= 40) return "medium";
	if (signal > 0) return "low";
	return "none";
}

/**
 * Why the network is refusing this radio, in operator copy.
 *
 * Precedence: an explicit rejection the NETWORK stated outranks anything we
 * could infer, and a detached packet service is only worth naming once the
 * radio claims to be registered — during `searching` it is the expected
 * intermediate, not a fault.
 *
 * Returns `undefined` when the device stated nothing, which is not the same as
 * "all is well": it means nothing was reported, so nothing is claimed.
 */
export function registrationRejectionKey(modem: Modem): string | undefined {
	const error = modem.registration_rejection?.error?.trim();
	if (error !== undefined && error !== "") {
		return REJECTION_REASON_KEYS[error] ?? "network.cellular.rejection.unknown";
	}

	const connection = modem.status?.connection;
	if (
		modem.packet_service_state === "detached" &&
		connection !== undefined &&
		DATA_EXPECTED_STATES.has(connection)
	) {
		return "network.cellular.rejection.packetDetached";
	}

	return undefined;
}

/**
 * The bond toggle is ALWAYS rendered; this resolves whether it is live and, if
 * not, WHY — the reason is surfaced both as the control's accessible name and
 * as an on-screen line, because the device ships with a kiosk touchscreen that
 * cannot hover to reveal a tooltip.
 *
 * A `router-ethernet` row is never live here even when it is `up`: the veth
 * that carries its traffic already owns a live toggle on its own interface row,
 * and two live controls for one link is how they disagree.
 */
export function bondDisabledReasonKey(
	modem: Modem,
	band: ModemClassBand,
	state: ModemRowState,
	hasAddress: boolean,
): string | undefined {
	if (isSimlessModem(modem)) return "network.view.noSimBond";

	if (band === "router-ethernet") {
		if (state === "router-acquiring") return "network.dongle.blockedAcquiring";
		if (state === "router-down") return "network.dongle.blockedDown";
		// A dongle this stack reaches DIRECTLY has no veth row to defer to — its
		// own `enx…` interface is the bonded link and this is the only row it
		// gets. Claiming "bonding is managed on its network interface row" would
		// point at a row that no longer exists, about a dongle that may be
		// carrying bonded traffic at that moment.
		if (!DIRECT_ROUTER_REASONS.has(modem.availability_reason ?? "")) {
			return "network.cellular.bond.routerManagedLink";
		}
	}

	if (!hasAddress) return "network.cellular.bond.noAddress";

	return undefined;
}

/**
 * The Configure affordance opens the row's focused dialog — the ONLY place
 * advanced detail lives (Design Principle 3: no inline mega-forms). A device
 * this stack does not control has nothing to configure there, so the control is
 * disabled with a reason rather than opening a form that would do nothing.
 */
/**
 * Why this row's Configure control cannot open anything, or `undefined`.
 *
 * A router dongle is no longer refused CATEGORICALLY. It is refused when the
 * device has published no setting whose write this build has verified —
 * `router_admin.controls` is the backend's capability claim, and it is only
 * emitted after a real round-trip proved the write lands. So a Huawei HiLink
 * opens a dialog with two working switches, and a ZTE whose firmware accepts
 * every request and applies none still says so instead of offering them.
 *
 * That refusal gets its OWN sentence rather than the generic `routerManaged`
 * one every dongle's availability token already resolves to. Sharing the key
 * made the two collapse into one line, which was tidy and uninformative: an
 * operator comparing a working Huawei row against a refused ZTE row read the
 * identical "manages this connection itself" on both and had no way to see why
 * only one of them offers settings. The distinction IS the answer to their
 * question, so it has to be on screen. {@link rowNoteKeys} keeps the row's
 * two-line ceiling by superseding the generic line instead of collapsing it.
 *
 * ── A WITHHELD CONTROL SET IS NOT ALWAYS A DEVICE LIMITATION ────────────────
 *
 * `router_admin.controls` is ALSO absent while the dongle's own login stands:
 * the device's `gateRouterAdminByLock` withholds the capability and control
 * blocks below `open`/`unlocked`. Reading that as "no write was ever proven"
 * disabled Configure on exactly the devices whose dialog now carries the login
 * form — so the one control that can fix the state was unreachable, and the row
 * additionally blamed the hardware for it. A lock therefore OPENS the dialog:
 * there is genuinely something to do in there.
 */
export function configureDisabledReasonKey(
	band: ModemClassBand,
	modem?: Modem,
): string | undefined {
	if (band === "router-ethernet") {
		if (lockWithholdsCapabilities(deriveLockView(modem))) return undefined;
		return modem?.router_admin?.controls === undefined
			? "network.cellular.reason.routerControlsUnverified"
			: undefined;
	}
	if (band === "unmanaged") return "network.cellular.config.unmanaged";
	return undefined;
}

/**
 * A note key that makes another note key redundant on the same row.
 *
 * De-duplication by identity is not enough once one control's reason is a
 * strictly MORE SPECIFIC statement of another's: the unverified-write refusal
 * names why this particular dongle offers nothing AND still points at its own
 * web interface, so printing the generic sentence under it restates half of it
 * and grows the row back towards the wall todo 64 removed.
 */
const SUPERSEDED_NOTE_KEYS: Readonly<Record<string, string>> = {
	"network.cellular.reason.routerControlsUnverified":
		"network.cellular.reason.routerManaged",
};

/**
 * The row's explanation lines, in order and DE-DUPLICATED.
 *
 * Each disabled control contributes its own reason, and on a router dongle
 * those reasons overlap — rendered naively the row grew three sentences saying
 * two things, which reads as a wall rather than as an instrument. Identical
 * keys collapse and a superseded key drops (see {@link SUPERSEDED_NOTE_KEYS}),
 * so every row carries at most two lines and no fact is stated twice. Nothing
 * is DROPPED without a survivor that already states it: a reason that is not on
 * screen here does not exist anywhere, which is the bare-disabled-control
 * defect this list prevents.
 */
export function rowNoteKeys(input: {
	rejection?: string | undefined;
	availability?: string | undefined;
	bond?: string | undefined;
	configure?: string | undefined;
}): string[] {
	const notes: string[] = [];
	// The network's stated reason LEADS: it is the only line that explains why
	// the rest of the row looks the way it does, and "can't join the bonding
	// pool" above it merely restates the consequence.
	for (const key of [
		input.rejection,
		input.availability,
		input.bond,
		input.configure,
	]) {
		if (key === undefined || notes.includes(key)) continue;
		notes.push(key);
	}

	const superseded = new Set(
		notes
			.map((key) => SUPERSEDED_NOTE_KEYS[key])
			.filter((key): key is string => key !== undefined),
	);
	return notes.filter((key) => !superseded.has(key));
}

/**
 * The headline. The carrier is what an operator recognises under time pressure,
 * so it leads; the hardware name is the fallback and otherwise demotes to the
 * detail line.
 */
/**
 * The row's title: WHICH DEVICE this is.
 *
 * The carrier is deliberately NOT a candidate here, and that ordering is the
 * fix for a reported defect rather than a preference. `status.network` used to
 * outrank every device field, so the moment a radio registered, the operator's
 * modem — `RM530N-GL - 16855` — was replaced in the title by `Movistar` and
 * demoted to a dim secondary line: the carrier covered the device name and its
 * identifier exactly when the row mattered most. A row identifies its HARDWARE,
 * because that is the thing an operator unplugs, moves between slots and owns
 * two of; the carrier is a status fact and now renders as one, in its own badge
 * beside the state (see {@link carrierLabel}).
 */
export function primaryLabel(modem: Modem, fallback = ""): string {
	for (const candidate of [modem.name, modem.slot_label, fallback]) {
		const value = candidate?.trim();
		if (value !== undefined && value !== "") return value;
	}
	return "";
}

/**
 * The network the radio is actually on, or `undefined` when it is on none.
 *
 * `sim_network` is the fallback rather than an equal: it is the SIM's home
 * operator, which is what the row can honestly say before registration, and it
 * is what a roaming radio would misreport if it were preferred.
 */
export function carrierLabel(modem: Modem): string | undefined {
	for (const candidate of [modem.status?.network, modem.sim_network]) {
		const value = candidate?.trim();
		if (value !== undefined && value !== "") return value;
	}
	return undefined;
}

/**
 * Secondary identity line: the hardware name (when it is not already the
 * headline) and the active network type. Empty ⇒ the component renders no line
 * at all rather than an empty one.
 */
export function detailLine(modem: Modem, primary: string): string | undefined {
	const parts: string[] = [];
	const name = modem.name?.trim() ?? "";
	if (name !== "" && name !== primary) parts.push(name);
	const networkType = modem.status?.network_type?.trim();
	if (networkType !== undefined && networkType !== "") parts.push(networkType);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The SIM/dongle slot badge, suppressed when it would merely repeat the
 * headline — a router dongle's slot label IS its name, and a badge echoing the
 * line above it is noise rather than information.
 */
export function slotBadgeLabel(
	modem: Modem,
	primary: string,
): string | undefined {
	const slot = modem.slot_label?.trim();
	if (slot === undefined || slot === "" || slot === primary) return undefined;
	return slot;
}

/*
 * ────────────────────────────────────────────────────────────────────────────
 * Router-dongle admin readings
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A `router-ethernet` row has no `status` and never will, so without these it
 * is the emptiest row in the section — precisely the device an operator most
 * needs explained, since "attached but carrying nothing" and "attached with no
 * SIM in it" look identical from here. Every value below was READ FROM THE
 * DEVICE by the backend probe; `unknown` resolves to no line at all rather than
 * to a reassuring default.
 */

const ROUTER_ADMIN_SIM_KEYS: Readonly<Record<string, string>> = {
	absent: "network.routerCellular.simAbsent",
	present: "network.routerCellular.simPresent",
};

const ROUTER_ADMIN_CONNECTION_KEYS: Readonly<Record<string, string>> = {
	connected: "network.routerCellular.connConnected",
	connecting: "network.routerCellular.connConnecting",
	disconnected: "network.routerCellular.connDisconnected",
};

export function routerAdminSimKey(modem: Modem): string | undefined {
	const sim = modem.router_admin?.sim;
	return sim === undefined ? undefined : ROUTER_ADMIN_SIM_KEYS[sim];
}

export function routerAdminConnectionKey(modem: Modem): string | undefined {
	const connection = modem.router_admin?.connection;
	return connection === undefined
		? undefined
		: ROUTER_ADMIN_CONNECTION_KEYS[connection];
}

/**
 * Bars only when the device stated BOTH the reading and its own scale — a bar
 * count with no maximum is not a signal level, it is a number.
 */
export function routerAdminSignal(
	modem: Modem,
): { bars: number; max: number } | undefined {
	const bars = modem.router_admin?.signal_bars;
	const max = modem.router_admin?.signal_max_bars;
	if (bars === undefined || max === undefined || max <= 0) return undefined;
	return { bars, max };
}

/**
 * The dongle's admin ADDRESS, from the same `admin_url` the note beside it
 * renders — read once, never probed a second time.
 *
 * The scheme is dropped because the fact strip states an address rather than a
 * link (this page cannot reach it directly; the proxy button is what opens it),
 * and a value under an "Admin IP" label that reads `http://…` describes a URL.
 * Anything that does not parse as a URL is passed through untouched rather than
 * pattern-stripped — the backend builds this from `ip route`, so an unexpected
 * shape is a reading we should not be reformatting.
 */
export function routerAdminHost(modem: Modem): string | undefined {
	const raw = modem.router_admin?.admin_url;
	if (raw === undefined || raw === "") return undefined;
	try {
		return new URL(raw).host;
	} catch {
		return raw;
	}
}

/** Does the probe have anything to show beyond the admin address itself? */
export function hasRouterAdminDetail(modem: Modem): boolean {
	return (
		routerAdminSimKey(modem) !== undefined ||
		routerAdminConnectionKey(modem) !== undefined ||
		routerAdminSignal(modem) !== undefined ||
		(modem.router_admin?.apn ?? "") !== "" ||
		(modem.router_admin?.serial ?? "") !== ""
	);
}
