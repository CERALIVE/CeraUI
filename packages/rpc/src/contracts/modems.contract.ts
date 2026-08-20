/**
 * Modems ORPC Contract
 */
import { oc } from '@orpc/contract';

import {
	modemBandsInputSchema,
	modemBandsOutputSchema,
	modemConfigInputSchema,
	modemConfigOutputSchema,
	modemGpsInputSchema,
	modemGpsOutputSchema,
	modemListSchema,
	modemMutationAckInputSchema,
	modemMutationAckOutputSchema,
	modemMutationDecommissionInputSchema,
	modemMutationListOutputSchema,
	modemMutationRebaselineInputSchema,
	modemScanInputSchema,
	modemScanOutputSchema,
	modemSmsInputSchema,
	modemSmsOutputSchema,
	setFiveGPreferenceInputSchema,
	setFiveGPreferenceOutputSchema,
	setModemBandsInputSchema,
	setModemBandsOutputSchema,
	setModemGpsInputSchema,
	setModemGpsOutputSchema,
	setRouterControlInputSchema,
	setRouterControlOutputSchema,
	setRouterNetModeInputSchema,
	setRouterNetModeOutputSchema,
	setRouterSubnetInputSchema,
	setRouterSubnetOutputSchema,
	setUsbModeInputSchema,
	setUsbModeOutputSchema,
	simPin2UnlockInputSchema,
	simPin2UnlockOutputSchema,
	simPukUnlockInputSchema,
	simPukUnlockOutputSchema,
	simUnlockInputSchema,
	simUnlockOutputSchema,
	usbModeOptionsInputSchema,
	usbModeOptionsOutputSchema,
} from '../schemas';

export const modemsContract = oc.router({
	/**
	 * Get all modems status
	 */
	getAll: oc.output(modemListSchema),

	/**
	 * Configure a modem
	 */
	configure: oc.input(modemConfigInputSchema).output(modemConfigOutputSchema),

	/**
	 * Scan for available networks
	 */
	scan: oc.input(modemScanInputSchema).output(modemScanOutputSchema),

	/**
	 * Submit a SIM PIN to unlock a PIN-locked modem
	 */
	unlockSim: oc.input(simUnlockInputSchema).output(simUnlockOutputSchema),

	/**
	 * Submit a SIM PUK + new PIN to recover a PUK-locked modem
	 */
	unlockSimPuk: oc.input(simPukUnlockInputSchema).output(simPukUnlockOutputSchema),

	/**
	 * Verify the SIM's PIN2 (the Fixed-Dialling-Number / call-cost credential).
	 * This is NOT `unlockSim` with a different code: PIN2 gates restricted SIM
	 * services rather than the card, and ModemManager exposes no PIN2 operation
	 * at all, so it is submitted over libqmi instead of mmcli.
	 */
	unlockSimPin2: oc.input(simPin2UnlockInputSchema).output(simPin2UnlockOutputSchema),

	/**
	 * Switch a modem's USB composition mode. Guarded by the default-absent
	 * `modem_provisioning` config key: while that key is absent the procedure
	 * refuses with `provisioning_disabled` at the RPC layer, so a direct call is
	 * refused exactly like a UI one.
	 */
	setUsbMode: oc.input(setUsbModeInputSchema).output(setUsbModeOutputSchema),

	/**
	 * Which composition modes are CERTIFIED for this exact device — a pure read
	 * of the same catalog `setUsbMode` gates on, so a control is only ever
	 * rendered for a transition the device would actually accept. An empty
	 * `certified` set means no control may be offered, never a disabled one.
	 */
	getUsbModeOptions: oc.input(usbModeOptionsInputSchema).output(usbModeOptionsOutputSchema),

	/**
	 * Which bands this modem advertises, which it currently uses, and which a
	 * control may OFFER — a pure read of the same certification catalog
	 * `setBands` gates on, so a band is never rendered that the device would
	 * refuse to lock to.
	 *
	 * `offerable` is EMPTY, and the answer is the typed `uncertified` refusal,
	 * until reviewed evidence proves set + readback + reset on this exact
	 * model+firmware. Band lock is deliberately stricter than the capability
	 * framework's `capable` floor: an unproven lock can strand the uplink on a
	 * band the network does not operate on, with no way back short of a replug.
	 */
	getBands: oc.input(modemBandsInputSchema).output(modemBandsOutputSchema),

	/**
	 * Lock the modem to a band selection, or release the lock with `['any']`.
	 *
	 * Runs under the shared capability-mutation helper — feature gate, per-device
	 * lease, reciprocal streaming refusal, and a durable journal entry armed
	 * BEFORE the write. Registration is then PROVEN within a bound; if it is not,
	 * the previous selection is restored automatically, and a backend that dies
	 * inside that window rolls the change back on its next boot from the journal.
	 */
	setBands: oc.input(setModemBandsInputSchema).output(setModemBandsOutputSchema),

	/**
	 * Change one setting on a router-mode dongle through its own HTTP admin API.
	 *
	 * The surface is deliberately tiny: only settings whose write was observed to
	 * take effect on real hardware are reachable here, and the handler proves each
	 * write by re-reading the device before reporting success.
	 */
	/**
	 * Rank 5G against LTE on a modem that advertises both.
	 *
	 * Gated by the default-absent `modem_capabilities.five_g_pref` key AND by the
	 * modem's own advertised mode catalog, so a direct call is refused exactly
	 * like a UI one. It re-registers the radio, so it runs under the journaled
	 * mutation lease with a crash-surviving rollback armed before the write, and
	 * it reports success only on a READBACK that landed on the requested posture —
	 * mmcli confirming the call is not the radio taking the mode set.
	 */
	setFiveGPreference: oc
		.input(setFiveGPreferenceInputSchema)
		.output(setFiveGPreferenceOutputSchema),

	setRouterControl: oc.input(setRouterControlInputSchema).output(setRouterControlOutputSchema),

	/**
	 * Select one of the radio modes the dongle's OWN firmware advertised.
	 *
	 * Capability-gated, not version-gated: the handler re-reads
	 * `/api/net/net-mode-list` in the same cycle and refuses before building any
	 * request document when the firmware will not name a catalog — so a unit that
	 * answers `112008` is never posted to and the operator is told that code.
	 */
	setRouterNetMode: oc.input(setRouterNetModeInputSchema).output(setRouterNetModeOutputSchema),

	/**
	 * Move the dongle's LAN subnet. OPTIONAL HYGIENE, never a prerequisite.
	 *
	 * Two same-model dongles sharing one factory subnet already bond; what the
	 * collision costs is address-steered operations on the host. The handler arms a
	 * durable rollback BEFORE the write and auto-restores when the device does not
	 * answer at its new address.
	 */
	setRouterSubnet: oc.input(setRouterSubnetInputSchema).output(setRouterSubnetOutputSchema),

	/**
	 * Read a modem's stored SMS inbox, newest first.
	 *
	 * READ-ONLY AND PERMANENTLY SO. This router will never gain a `sendSms` or
	 * `deleteSms` sibling: the whole surface is ModemManager's list + per-message
	 * read, which adds no modem-control capability the device did not already
	 * have. A modem with no Messaging interface answers a typed `unsupported`
	 * rather than an empty inbox.
	 */
	getSms: oc.input(modemSmsInputSchema).output(modemSmsOutputSchema),

	/**
	 * Read GNSS capability, whether it is switched on, and the CURRENT fix.
	 *
	 * There is no history sibling and never will be: the fix lives in memory for
	 * as long as an operator is looking at it, and the reply carries at most one.
	 * The reply also advances the bounded no-fix / stale-fix state machine, so a
	 * modem with no antenna reaches an honest terminal `no-fix` rather than
	 * leaving a caller polling a spinner forever.
	 */
	getGps: oc.input(modemGpsInputSchema).output(modemGpsOutputSchema),

	/**
	 * Switch the modem's GNSS sources on or off.
	 *
	 * Runs under the capability-module mutation lease and is NOT journaled: it
	 * touches no bearer, so there is no bond link for a rollback to restore.
	 * Disabling also CLEARS any held fix — the coordinates do not outlive the
	 * receiver being on.
	 */
	setGps: oc.input(setModemGpsInputSchema).output(setModemGpsOutputSchema),

	/**
	 * List every device the mutation journal is currently holding blocked, plus
	 * whether replay itself has finished. A UI cannot honestly render "nothing is
	 * wrong" while replay is still running, so the flag rides the same read.
	 */
	listMutationBlocks: oc.output(modemMutationListOutputSchema),

	/**
	 * Acknowledge a failed modem mutation through ONE of the two typed paths.
	 * Neither is a dismissal: `verified-rollback` re-reads the device and refuses
	 * unless it matches the journaled pre-state, and `force-rebaseline` captures
	 * and validates the CURRENT hardware state as the new baseline before
	 * anything is unblocked.
	 */
	acknowledgeMutation: oc.input(modemMutationAckInputSchema).output(modemMutationAckOutputSchema),

	/**
	 * Confirm a quarantined modem is gone. Only that physical identity stays
	 * mutation-blocked; global stream autostart is released, so a destroyed modem
	 * can never permanently strand the remaining links.
	 */
	decommissionMutation: oc
		.input(modemMutationDecommissionInputSchema)
		.output(modemMutationAckOutputSchema),

	/**
	 * Adopt the device now present at a decommissioned identity as the new
	 * baseline. Required because identity is PORT-based for serial-less devices,
	 * so a replacement modem inherits the key and must not silently inherit the
	 * previous unit's blocked history either.
	 */
	rebaselineMutation: oc
		.input(modemMutationRebaselineInputSchema)
		.output(modemMutationAckOutputSchema),

	/**
	 * Subscribe to modem status changes
	 */
	onStatusChange: oc,
});
