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
 * THE STACK↔UI PARITY MANIFEST — every modem surface, dispositioned on purpose.
 *
 * This is the MACHINE half of the modem parity audit. It exists so the next
 * change to `@ceralive/modem-control`, or to CeraUI's own modem RPC surface,
 * cannot grow a capability the UI has silently never dispositioned. The gate
 * that reads it is `src/tests/modem-parity-drift.test.ts`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A DISPOSITION IS A SENTENCE, NOT A BOOLEAN
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Every row carries a `reason`, and that is the whole point of the file. A
 * boolean tells a future reviewer that a gate went red; a reason tells them what
 * the row CLAIMED, so they can decide whether the new surface changes the claim
 * or merely needs a row. The four dispositions are deliberately distinct:
 *
 *   `wired`          — an operator surface exists and renders this.
 *   `unwired`        — the stack/backend supports it; there is NO operator
 *                      surface. A real gap, recorded rather than hidden.
 *   `absent`         — neither a backend projection nor an operator surface.
 *   `not-applicable` — absence is BY DESIGN, not a gap. Reserved for surfaces
 *                      the stack itself refuses to expose (the UFI/HIMI
 *                      prohibitions), where shipping a control would contradict
 *                      an inert safety fence.
 *
 * `not-applicable` and `absent` must never be collapsed: one says "nobody built
 * it", the other says "building it is the defect".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THERE ARE THREE RECORDS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The pinned package's ENUMERABLE surface and its OPERATION surface are not the
 * same size, and neither is the surface CeraUI's own backend dispatches:
 *
 *  - `CAPABILITY_MODULE_PARITY` mirrors the package's exported capability-module
 *    list (`capability/support-claim.ts`). It is enumerable TODAY, so the gate
 *    holds it to strict set equality in both directions.
 *  - `OPERATION_PARITY` mirrors the concrete provider operation ids. v1.1.0
 *    exports no registry for these — the common `ProviderOperationsSurface`
 *    carries no operation-id list and provider operations are named properties
 *    on heterogeneous runtime objects — so the gate's set-equality assertion for
 *    this record is written but disarmed, pending the package-owned registry.
 *  - `BACKEND_RPC_PARITY` mirrors the modem RPC procedures CeraUI's OWN backend
 *    dispatches. This is the axis that catches a UI surface with no disposition:
 *    a new `modems.*` procedure lands, no row claims it, the gate goes red. The
 *    gate derives the real set from the backend's router source at test time and
 *    never from a list re-typed here.
 *
 * This file names NO path outside the CeraUI checkout root, and neither does its
 * gate (Rule D). The workspace-level ledger that informed these dispositions is
 * a human artifact and is deliberately not read by anything here.
 */

/** The four dispositions a modem surface may carry. */
export const UI_DISPOSITIONS = [
	"wired",
	"unwired",
	"absent",
	"not-applicable",
] as const;

export type UiDisposition = (typeof UI_DISPOSITIONS)[number];

export interface ParityRow {
	readonly disposition: UiDisposition;
	/**
	 * One line, in plain language, saying WHY this row carries this disposition.
	 * A reviewer reading a red gate acts on this sentence, so it must name the
	 * surface (or the reason there is none) rather than restate the disposition.
	 */
	readonly reason: string;
}

export type ParityRecord = Readonly<Record<string, ParityRow>>;

/**
 * The seven gated capability modules `@ceralive/modem-control` exports.
 *
 * Keys MUST equal the package's own `CAPABILITY_MODULES`; the gate asserts that
 * in both directions, so an eighth module fails until it is dispositioned here.
 */
export const CAPABILITY_MODULE_PARITY: ParityRecord = {
	"band-lock": {
		disposition: "wired",
		reason:
			"ModemConfigDialog renders the band controls behind the Settings capability gate; the shipped certification catalog is empty, so every device refuses the write today.",
	},
	sms: {
		disposition: "wired",
		reason:
			"ModemConfigDialog's folded, permanently read-only SMS card renders the inbox; there is no compose, reply or delete affordance anywhere.",
	},
	"five-g-pref": {
		disposition: "wired",
		reason:
			"ModemConfigDialog's network-type controls render the modem's own advertised (allowed, preferred) postures; uncertified because no 5G SIM or coverage exists at the bench.",
	},
	"fcc-auto-unlock": {
		disposition: "wired",
		reason:
			"ModemFccUnlockSection renders the per-model opt-in and its tri-state coverage verdict.",
	},
	gps: {
		disposition: "wired",
		reason:
			"ModemGpsSection renders the live-fix surface; there is deliberately no history, track, export or upload affordance.",
	},
	ussd: {
		disposition: "unwired",
		reason:
			"The session machine, refusal taxonomy and all four RPC procedures ship, and NO operator surface dispatches them — the known gap this manifest exists to record honestly.",
	},
	esim: {
		disposition: "absent",
		reason:
			"No gate implementation, no RPC and no operator surface; the adoption spike closed blocked because no bench modem exposes an eUICC.",
	},
};

/**
 * The concrete provider operation ids the pinned package's providers expose.
 *
 * Ids are the provider's OWN names: ModemManager's are prefixed, Huawei HiLink's
 * are the bare property names its operations object publishes, and the UFI/HIMI
 * ids are the literal keys of its frozen prohibition table.
 */
export const OPERATION_PARITY: ParityRecord = {
	"modemmanager.radio-modes": {
		disposition: "wired",
		reason:
			"ModemConfigDialog's network-type selector writes the ordered RAT preference through modems.configure.",
	},
	"modemmanager.modes": {
		disposition: "wired",
		reason:
			"The 5G-preference control selects one advertised (allowed, preferred) combination verbatim; a posture the modem never advertised is refused, never rounded.",
	},
	"modemmanager.bands": {
		disposition: "wired",
		reason:
			"ModemConfigDialog's band controls read generically and write only for a SKU the certification catalog covers.",
	},
	"modemmanager.signal": {
		disposition: "wired",
		reason:
			"CellularSection renders the modem's own signal tier; the reading rides the modems broadcast rather than a per-open read.",
	},
	"modemmanager.sim": {
		disposition: "wired",
		reason:
			"The SIM state drives the row's lock badge and the operator-opened SimUnlockDialog.",
	},
	"modemmanager.power": {
		disposition: "unwired",
		reason:
			"The idempotent radio-power read is available to the provider and reaches no wire field and no operator surface.",
	},
	status: {
		disposition: "wired",
		reason:
			"Huawei HiLink's authenticated status read populates RouterDongleDialog's fact strip and the Cellular row's admin facts.",
	},
	signal: {
		disposition: "wired",
		reason:
			"Huawei HiLink's authenticated signal read drives the router-signal chip and its per-metric strip.",
	},
	mode: {
		disposition: "wired",
		reason:
			"RouterDongleDialog offers the firmware's own network-mode catalog as chips, and renders the vendor's refusal code when the capability read comes back refused.",
	},
	data: {
		disposition: "wired",
		reason:
			"RouterDongleDialog's mobile-data control writes through modems.setRouterControl with a readback-confirmed outcome band.",
	},
	"ufi.signal.read": {
		disposition: "wired",
		reason:
			"The UFI/HIMI signal read feeds the same router-signal chip; dBm is its only metric, so the strip renders one row.",
	},
	"ufi.details.read": {
		disposition: "wired",
		reason:
			"The UFI/HIMI details read populates RouterDongleDialog's operator and diagnostics field tables.",
	},
	"nv.write": {
		disposition: "not-applicable",
		reason:
			"An inert Qualcomm prohibition with no implementation anywhere; an operator control here would contradict a permanent safety fence.",
	},
	"efs.write": {
		disposition: "not-applicable",
		reason:
			"An inert Qualcomm prohibition with no implementation anywhere; an operator control here would contradict a permanent safety fence.",
	},
	"identity.write": {
		disposition: "not-applicable",
		reason:
			"An inert Qualcomm prohibition with no implementation anywhere; writing device identity is out of scope permanently.",
	},
	"calibration.write": {
		disposition: "not-applicable",
		reason:
			"An inert Qualcomm prohibition with no implementation anywhere; calibration writes are out of scope permanently.",
	},
	"firmware.flash": {
		disposition: "not-applicable",
		reason:
			"An inert Qualcomm prohibition with no implementation anywhere; firmware flashing is out of scope permanently.",
	},
	"edl.automation": {
		disposition: "not-applicable",
		reason:
			"An inert Qualcomm prohibition with no implementation anywhere; EDL automation is out of scope permanently.",
	},
	"driver.blind-retry": {
		disposition: "not-applicable",
		reason:
			"An inert Qualcomm prohibition with no implementation anywhere; blind driver rebinds are out of scope permanently.",
	},
	"interface.blind-retry": {
		disposition: "not-applicable",
		reason:
			"An inert Qualcomm prohibition with no implementation anywhere; blind interface retries are out of scope permanently.",
	},
	"diag.write": {
		disposition: "not-applicable",
		reason:
			"An inert Qualcomm prohibition with no implementation anywhere; DIAG writes are out of scope permanently.",
	},
	"diag.info-probe": {
		disposition: "not-applicable",
		reason:
			"Read-only and bench-supervised only; production access stays prohibited even where an interface descriptor proves a DIAG channel.",
	},
	"shell.transport-fallback": {
		disposition: "not-applicable",
		reason:
			"An inert Qualcomm prohibition with no implementation anywhere; production never falls back to ADB, SSH or telnet.",
	},
};

/**
 * Every modem RPC procedure CeraUI's own backend dispatches.
 *
 * Keys MUST equal the `modems` router's procedure set, derived from the backend
 * router source at test time. This is the axis that catches a UI surface with no
 * disposition, in BOTH directions: a new procedure with no row, and a row naming
 * a procedure the backend no longer dispatches.
 */
export const BACKEND_RPC_PARITY: ParityRecord = {
	"modems.getAll": {
		disposition: "wired",
		reason:
			"CellularSection renders the roster; the same payload reaches clients through the modems broadcast, and this procedure is its pull-equivalent.",
	},
	"modems.configure": {
		disposition: "wired",
		reason:
			"ModemConfigDialog's APN, credential, roaming, automatic-APN and network-type form saves through it.",
	},
	"modems.scan": {
		disposition: "wired",
		reason:
			"ModemConfigDialog's operator scan dispatches it and renders the typed scan outcome.",
	},
	"modems.unlockSim": {
		disposition: "wired",
		reason:
			"SimUnlockDialog submits a PIN, reached from the modem row's own Unlock SIM action.",
	},
	"modems.unlockSimPin2": {
		disposition: "unwired",
		reason:
			"The PIN2 path is reachable in code but deliberately never surfaced — PIN2 gates only the SIM's fixed-dialling list, which this product does not expose, and the unlock cannot persist across a power cycle.",
	},
	"modems.unlockSimPuk": {
		disposition: "wired",
		reason:
			"SimUnlockDialog's PUK branch submits it and renders the remaining-attempt warning.",
	},
	"modems.setUsbMode": {
		disposition: "wired",
		reason:
			"ModemConfigDialog's USB-composition card dispatches the confirm-guarded switch and waits for the device's own confirming broadcast.",
	},
	"modems.getUsbModeOptions": {
		disposition: "wired",
		reason:
			"The same card reads the certified target set once per open, so only transitions the device would accept are offered.",
	},
	"modems.getFccUnlock": {
		disposition: "wired",
		reason:
			"ModemFccUnlockSection reads the per-model policy and its coverage verdict.",
	},
	"modems.setFccUnlock": {
		disposition: "wired",
		reason: "ModemFccUnlockSection writes the per-model opt-in.",
	},
	"modems.getBands": {
		disposition: "wired",
		reason:
			"ModemConfigDialog's band controls read the supported, current and offerable band sets.",
	},
	"modems.setBands": {
		disposition: "wired",
		reason:
			"The same controls write a band lock, refused device-side unless the SKU resolves to a certification entry.",
	},
	"modems.getCapabilities": {
		disposition: "wired",
		reason:
			"The Settings Cellular Features dialog reads the device-wide capability gates.",
	},
	"modems.setCapabilities": {
		disposition: "wired",
		reason:
			"The same dialog writes one gate at a time, pessimistically, moving only on the device's own applied record.",
	},
	"modems.setFiveGPreference": {
		disposition: "wired",
		reason:
			"ModemConfigDialog's 5G-preference control writes the selected posture.",
	},
	"modems.openRouterAdmin": {
		disposition: "wired",
		reason:
			"The Cellular row and RouterDongleDialog both open the dongle's own admin UI through the device-bound reverse proxy.",
	},
	"modems.setRouterControl": {
		disposition: "wired",
		reason:
			"RouterDongleDialog's proven router toggles write through it and render a readback-confirmed outcome band.",
	},
	"modems.setRouterNetMode": {
		disposition: "wired",
		reason:
			"RouterDongleDialog's network-mode chips write through it, offered only when the firmware's capability read reported a catalog.",
	},
	"modems.setRouterSubnet": {
		disposition: "unwired",
		reason:
			"The capability-gated, journaled LAN-subnet rewrite ships server-side with no operator control, because its auto-restore has never been exercised on hardware.",
	},
	"modems.getSms": {
		disposition: "wired",
		reason:
			"ModemConfigDialog's SMS card reads the inbox on disclosure, never on dialog open.",
	},
	"modems.getGps": {
		disposition: "wired",
		reason: "ModemGpsSection reads the GNSS capability and fix state.",
	},
	"modems.setGps": {
		disposition: "wired",
		reason: "ModemGpsSection enables and disables GNSS.",
	},
	"modems.getUssd": {
		disposition: "unwired",
		reason:
			"The USSD session state is readable and NO operator surface reads it; this is the ussd capability module's gap, at the RPC layer.",
	},
	"modems.ussdInitiate": {
		disposition: "unwired",
		reason: "Opens a USSD dialogue; no operator surface dispatches it.",
	},
	"modems.ussdRespond": {
		disposition: "unwired",
		reason: "Answers an open USSD dialogue; no operator surface dispatches it.",
	},
	"modems.ussdCancel": {
		disposition: "unwired",
		reason:
			"Releases an open USSD dialogue network-side; no operator surface dispatches it, so a session opened out of band can only be closed by its own timeout.",
	},
	"modems.listMutationBlocks": {
		disposition: "unwired",
		reason:
			"Reports which physical modems a failed rollback still blocks; no operator surface renders the list.",
	},
	"modems.acknowledgeMutation": {
		disposition: "unwired",
		reason:
			"Clears a blocked modem through a verified rollback or a force-rebaseline; no operator surface offers either path.",
	},
	"modems.decommissionMutation": {
		disposition: "unwired",
		reason:
			"Records that a blocked modem is physically gone so it stops holding streaming; no operator surface offers it.",
	},
	"modems.rebaselineMutation": {
		disposition: "unwired",
		reason:
			"Accepts a replacement modem in a decommissioned device's port as the new baseline; no operator surface offers it.",
	},
};
