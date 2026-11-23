export type VirtualHotspotBinding = {
	readonly ifname: string;
	readonly activeConn: string | null;
};

type BindingOwner = {
	concurrentHotspot?: VirtualHotspotBinding;
	hotspot?: { conn?: string };
	activeConn?: string | null;
	activeMode?: string;
};

type BindingChange =
	| {
			readonly kind: "set";
			readonly ifname: string;
			readonly activeConn: string | null;
	  }
	| { readonly kind: "pending"; readonly ifname: string }
	| { readonly kind: "associate" }
	| { readonly kind: "clear" }
	| { readonly kind: "retire"; readonly parentConn?: string | null }
	| { readonly kind: "discard"; readonly parentConn?: string | null }
	| {
			readonly kind: "parent";
			readonly connection: string | null;
			readonly mode: string;
	  };

const associatedProfiles = new WeakMap<VirtualHotspotBinding, string>();
// Retired Stop authority does not erase a reusable inactive profile hint.
const retiredTargets = new WeakMap<BindingOwner, string>();

/** The only writer of virtual bindings and their associated Stop target. */
export function transitionVirtualBinding(
	row: BindingOwner,
	change: BindingChange,
): boolean {
	const previous = row.concurrentHotspot;
	const associated = previous
		? (associatedProfiles.get(previous) ?? previous.activeConn)
		: undefined;
	const cached = row.hotspot?.conn;
	const retire = (
		parentConn: string | null | undefined,
		discard = false,
	): boolean => {
		if (
			!associated ||
			cached !== associated ||
			!row.hotspot ||
			parentConn === cached
		)
			return false;
		const changed = retiredTargets.get(row) !== associated;
		retiredTargets.set(row, associated);
		if (discard && row.hotspot) {
			delete row.hotspot.conn;
			retiredTargets.delete(row);
		}
		return changed || discard;
	};
	switch (change.kind) {
		case "associate":
			if (previous && cached) associatedProfiles.set(previous, cached);
			return false;
		case "pending": {
			if (previous && previous.ifname !== change.ifname) retire(row.activeConn);
			const next = { ifname: change.ifname, activeConn: null };
			const profile = row.hotspot?.conn ?? associated;
			if (profile) associatedProfiles.set(next, profile);
			row.concurrentHotspot = next;
			return true;
		}
		case "parent": {
			if (!cached || !row.hotspot) return false;
			const priorParent = row.activeMode === "ap" && row.activeConn === cached;
			const virtualTarget =
				associated === cached || retiredTargets.get(row) === cached;
			if (change.mode === "ap" && change.connection === cached) {
				retiredTargets.delete(row);
				return false;
			}
			if (change.mode === "ap" && (priorParent || virtualTarget)) {
				delete row.hotspot.conn;
				retiredTargets.delete(row);
				return true;
			}
			if (priorParent) retiredTargets.set(row, cached);
			return false;
		}
		case "set": {
			const same =
				previous?.ifname === change.ifname &&
				previous.activeConn === change.activeConn;
			const invalidated =
				previous?.ifname !== change.ifname ||
				(change.activeConn !== null && associated !== change.activeConn) ||
				change.activeConn === null;
			const retired = previous && invalidated ? retire(row.activeConn) : false;
			const next =
				same && previous
					? previous
					: {
							ifname: change.ifname,
							activeConn: change.activeConn,
						};
			const profile = change.activeConn ?? associated;
			if (profile) associatedProfiles.set(next, profile);
			if (change.activeConn && retiredTargets.get(row) === change.activeConn)
				retiredTargets.delete(row);
			row.concurrentHotspot = next;
			return !same || retired;
		}
		case "clear": {
			if (!previous) return false;
			const retired = retire(row.activeConn);
			const next = { ifname: previous.ifname, activeConn: null };
			if (associated) associatedProfiles.set(next, associated);
			row.concurrentHotspot = next;
			return previous.activeConn !== null || retired;
		}
		case "discard":
		case "retire": {
			const retired = retire(
				"parentConn" in change ? change.parentConn : row.activeConn,
				change.kind === "discard",
			);
			if (previous) associatedProfiles.delete(previous);
			delete row.concurrentHotspot;
			return previous !== undefined || retired;
		}
	}
}
