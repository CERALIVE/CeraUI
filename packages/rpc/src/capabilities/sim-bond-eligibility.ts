/**
 * Whether a cellular link is SIM-LESS, and therefore may never join the bond.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS LIVES HERE RATHER THAN IN EITHER CONSUMER
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A SIM-less link cannot carry a byte of cellular traffic, so bonding it spends
 * a real bond slot on a dead uplink. TWO layers have to agree about that, and
 * they answer different halves of the same question:
 *
 *   - the DEVICE decides membership — `isBondCandidate` feeds `genSrtlaIpList`,
 *     which is the source-IP list `srtla_send` actually dials;
 *   - the UI decides what the operator may TOGGLE.
 *
 * Two copies of one rule drift, and every way they drift is a lie: a live
 * toggle over a link the device refuses, or a disabled toggle over a link the
 * device is happily bonding. This is the same argument — and the same
 * resolution — as {@link ./device-mode-truth.ts}, which the backend save path
 * and the frontend offering share for exactly that reason.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO MODEM CLASSES REPORT SIM PRESENCE THROUGH DIFFERENT FIELDS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * That asymmetry IS the defect this rule closes. A directly-managed modem
 * reports the slot through ModemManager, which the wire carries as `no_sim`;
 * a `router-ethernet` dongle is architecturally invisible to ModemManager and
 * reports through its OWN embedded admin API, which the wire carries as
 * `router_admin.sim`. The bond gate only ever consulted the first, so the same
 * physical condition disabled the toggle on one class and left it live on the
 * other — a SIM-less ZTE MF79U and a SIM-less Qualcomm UFI were both bonded on
 * the bench while their SIM-less Huawei siblings were not.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POSITIVE EVIDENCE ONLY — THIS RULE MAY SUBTRACT, NEVER GUESS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Every arm requires the DEVICE to have said so. `unknown` is what a dialect
 * answers when it published a SIM code this build will not justify, and an
 * unreachable dongle carries no `sim` field at all — neither is evidence, and
 * both leave the link bondable. Refusing on an unknown would take a working
 * uplink out of a live bond because a 30 s HTTP probe missed one cycle, which
 * is a worse failure than the one being fixed.
 */

/** The dongle's own admin-API SIM verdict (`RouterAdminSim` on the device). */
export type RouterSimVerdict = 'absent' | 'present' | 'unknown';

/**
 * What each modem class can say about its own SIM slot. Both fields are
 * optional because most rows carry exactly one of them: a `router-ethernet`
 * dongle has no `no_sim`, and a directly-managed modem has no `router_admin`.
 */
export interface SimBondEvidence {
	/** ModemManager's slot verdict, for a directly-managed modem. */
	readonly noSim?: boolean | undefined;
	/** The dongle's own admin-API verdict, for a `router-ethernet` dongle. */
	readonly routerSim?: RouterSimVerdict | undefined;
}

/**
 * Has a device POSITIVELY reported that it holds no SIM?
 *
 * `true` is the only answer that gates anything, and it is reachable only from
 * a device-stated fact. Absent, `unknown`, and `present` all resolve `false`.
 */
export function isSimlessForBond(evidence: SimBondEvidence): boolean {
	if (evidence.noSim === true) return true;
	return evidence.routerSim === 'absent';
}
