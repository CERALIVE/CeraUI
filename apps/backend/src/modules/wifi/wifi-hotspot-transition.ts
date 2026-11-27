import { broadcastWifiModeSettlement } from "./wifi.ts";
import type { WifiInterfaceWithHotspot } from "./wifi-hotspot-types.ts";
import {
	currentWifiIncarnation,
	retireReplacedWifiModeWitness,
} from "./wifi-mode-witness.ts";

type Transition = NonNullable<
	WifiInterfaceWithHotspot["hotspot"]["transition"]
>;

// Recovery can still need the internal flag after the operation has settled.
type Hotspot = WifiInterfaceWithHotspot["hotspot"];
type Claim = {
	readonly hotspot: Hotspot;
	readonly incarnation: string | undefined;
	readonly transition: Transition;
};
const claims = new WeakMap<WifiInterfaceWithHotspot, Claim>();
const legacyStops = new WeakMap<Hotspot, Claim>();

export function claimHotspotTransition(
	row: WifiInterfaceWithHotspot,
	transition: Transition,
) {
	const hotspot = row.hotspot;
	const claim = {
		hotspot,
		incarnation: currentWifiIncarnation(row),
		transition,
	};
	claims.set(row, claim);
	if (transition === "deactivating") legacyStops.set(hotspot, claim);
	else legacyStops.delete(hotspot);
	hotspot.transition = transition;
	const clear = () => {
		if (claims.get(row) === claim && hotspot.transition === transition)
			delete hotspot.transition;
		const current = row.hotspot;
		if (
			legacyStops.get(current) === claim &&
			current.transition === "deactivating" &&
			claim.incarnation === currentWifiIncarnation(row)
		) {
			legacyStops.delete(current);
			delete current.transition;
		}
	};
	const finish = (publish = true) => {
		if (claims.get(row) !== claim) return;
		claims.delete(row);
		if (publish) broadcastWifiModeSettlement();
	};
	return {
		clear,
		finish,
		[Symbol.dispose]() {
			clear();
			finish();
		},
	};
}

export function projectHotspotTransition(
	row: WifiInterfaceWithHotspot,
): Transition | undefined {
	const claim = claims.get(row);
	if (
		claim?.hotspot === row.hotspot &&
		claim.incarnation === currentWifiIncarnation(row) &&
		claim.transition === row.hotspot.transition
	)
		return claim.transition;
	return undefined;
}

/** Withdraw profile-owned display markers without changing the legacy raw flag. */
export function retireReplacedHotspotTransition(
	row: WifiInterfaceWithHotspot,
	copiedFrom?: Hotspot,
) {
	if (copiedFrom && row.hotspot.transition === "deactivating") {
		// Only the Stop whose flag discovery copied may clear the inherited flag.
		const legacyStop = legacyStops.get(copiedFrom);
		if (legacyStop && legacyStop.incarnation === currentWifiIncarnation(row)) {
			legacyStops.delete(copiedFrom);
			legacyStops.set(row.hotspot, legacyStop);
		}
	}
	const releasedWitness = retireReplacedWifiModeWitness(row);
	const releasedTransition = claims.delete(row);
	if (releasedTransition || releasedWitness) broadcastWifiModeSettlement();
}
