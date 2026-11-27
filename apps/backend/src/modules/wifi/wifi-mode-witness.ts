import type { WifiAdapterMode } from "@ceraui/rpc/schemas";
import { broadcastWifiModeSettlement } from "./wifi.ts";
import { displayObservedWifiAdapterMode } from "./wifi-adapter-mode.ts";
import type { WifiInterfaceWithHotspot } from "./wifi-hotspot-types.ts";
import { wifiRadioIdentity } from "./wifi-radio-identity.ts";
import { projectWifiRadioIncarnation } from "./wifi-radio-publication.ts";

type ModeHold = {
	readonly incarnation: string | undefined;
	readonly hotspot: WifiInterfaceWithHotspot["hotspot"] | undefined;
	readonly admittedPrior: WifiAdapterMode | null | undefined;
	owners: number;
	prior?: WifiAdapterMode | null;
};

const hotspotHolds = new WeakMap<WifiInterfaceWithHotspot, ModeHold>();
const modeHolds = new WeakMap<WifiInterfaceWithHotspot, ModeHold>();

export function currentWifiIncarnation(row: WifiInterfaceWithHotspot) {
	const identity = wifiRadioIdentity.state.rows.get(row.ifname);
	// Use the identity, not its temporarily withheld wire projection.
	return identity?.row === row ? identity.incarnation : undefined;
}

function currentHold(
	row: WifiInterfaceWithHotspot,
	holds: WeakMap<WifiInterfaceWithHotspot, ModeHold>,
	incarnation: string | undefined,
) {
	const hold = holds.get(row);
	return hold?.incarnation === incarnation &&
		(hold?.hotspot === undefined || hold.hotspot === row.hotspot)
		? hold
		: undefined;
}

function holdWitness(
	row: WifiInterfaceWithHotspot,
	holds: WeakMap<WifiInterfaceWithHotspot, ModeHold>,
	hotspot?: WifiInterfaceWithHotspot["hotspot"],
	admittedPrior?: WifiAdapterMode | null,
): () => void {
	const incarnation = currentWifiIncarnation(row);
	const hold = currentHold(row, holds, incarnation) ?? {
		incarnation,
		hotspot,
		admittedPrior,
		owners: 0,
	};
	hold.owners++;
	holds.set(row, hold);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--hold.owners !== 0 || holds.get(row) !== hold) return;
		const visible = projectWifiModeWitness(row, currentWifiIncarnation(row));
		holds.delete(row);
		if (
			(hold.hotspot === row.hotspot && hold.prior !== undefined) ||
			visible !== projectWifiModeWitness(row, currentWifiIncarnation(row))
		)
			broadcastWifiModeSettlement();
	};
}

export function holdWifiModeWitness(row: WifiInterfaceWithHotspot) {
	return holdWitness(row, hotspotHolds, row.hotspot);
}

/** An admitted mode change survives profile renewal, but not radio renewal. */
export function trackWifiModeWitness(row: WifiInterfaceWithHotspot) {
	return holdWitness(
		row,
		modeHolds,
		undefined,
		displayObservedWifiAdapterMode(row),
	);
}

/** Keep the predecessor's prior on the direct Stop hold before Start settles. */
export function inheritWifiModeWitness(row: WifiInterfaceWithHotspot): void {
	const incarnation = currentWifiIncarnation(row);
	if (incarnation === undefined) return;
	const hotspot = currentHold(row, hotspotHolds, incarnation);
	const prior = currentHold(row, modeHolds, incarnation)?.prior;
	if (hotspot && hotspot.prior === undefined && prior !== undefined)
		hotspot.prior = prior;
}

export function captureWifiModeWitness(row: WifiInterfaceWithHotspot): void {
	const mode = currentHold(row, modeHolds, currentWifiIncarnation(row));
	if (mode?.admittedPrior !== undefined && mode.prior === undefined)
		mode.prior = mode.admittedPrior;
	const incarnation = projectWifiRadioIncarnation(
		row,
		wifiRadioIdentity.state.rows.get(row.ifname),
	);
	if (incarnation === undefined) return;
	const hotspot = currentHold(row, hotspotHolds, incarnation);
	if (hotspot && hotspot.prior === undefined)
		hotspot.prior = displayObservedWifiAdapterMode(row);
}

export function projectWifiModeWitness(
	row: WifiInterfaceWithHotspot,
	incarnation: string | undefined,
): WifiAdapterMode | null | undefined {
	if (incarnation === undefined) return;
	const mode = currentHold(row, modeHolds, incarnation)?.prior;
	return mode !== undefined
		? mode
		: currentHold(row, hotspotHolds, incarnation)?.prior;
}

export function retireReplacedWifiModeWitness(row: WifiInterfaceWithHotspot) {
	const hold = hotspotHolds.get(row);
	if (!hold || hold.hotspot === row.hotspot) return false;
	hotspotHolds.delete(row);
	return hold.prior !== undefined;
}
