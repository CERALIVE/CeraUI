/**
 * Pure OS-toggle confirm predicates — T18 (ceraui-os-interaction-ux)
 *
 * The hotspot start/stop and SSH start/stop dialogs both keep their keyed
 * async-operation `pending` after dispatch and resolve it only when the live
 * authoritative snapshot reports the intended target state (the per-surface
 * confirm `$effect`). The two decisions that drive those effects — "is the
 * surface active?" and "does the snapshot match the pending target?" — are
 * extracted here as rune-free, side-effect-free predicates so they can be
 * unit-tested directly and reused verbatim by the dialogs.
 *
 * Keeping them pure is the same discipline the sibling T5–T7 outcome modules
 * follow ({@link ./wifi-connect-outcome}, {@link ./modem-config-echo}); the
 * dialog stays a thin reactive shell over a tested core.
 */

/** The pending intent of a hotspot start/stop op (null = no op in flight). */
export type HotspotToggleTarget = "hotspot" | "station" | null;

/**
 * Whether a WiFi interface is currently broadcasting a hotspot. The interface
 * carries a live `hotspot` config object exactly when its AP is up, so its mere
 * presence is the active signal (mirrors HotspotDialog's `isActive`).
 */
export function hotspotIsActive(
	iface: { hotspot?: unknown } | null | undefined,
): boolean {
	return Boolean(iface?.hotspot);
}

/**
 * Whether a pending hotspot start/stop should now confirm: a `hotspot` target
 * confirms once the interface is active, a `station` target once it is inactive.
 * A `null` target (no op in flight) never confirms.
 */
export function hotspotToggleConfirmed(
	target: HotspotToggleTarget,
	isActive: boolean,
): boolean {
	if (target === "hotspot") return isActive;
	if (target === "station") return !isActive;
	return false;
}

/**
 * Whether the SSH server is active. `ssh.active` is the authoritative status
 * field; an absent status is treated as inactive (mirrors SshDialog's `active`).
 */
export function sshIsActive(
	ssh: { active?: boolean } | null | undefined,
): boolean {
	return ssh?.active ?? false;
}

/**
 * Whether a pending SSH start/stop should now confirm: the live `ssh.active`
 * exactly matches the intended target. A `null` target (no op in flight) never
 * confirms — distinct from `active === false`, which is a real "now stopped"
 * confirm for a `stop` op.
 */
export function sshToggleConfirmed(
	active: boolean,
	target: boolean | null,
): boolean {
	return target !== null && active === target;
}
