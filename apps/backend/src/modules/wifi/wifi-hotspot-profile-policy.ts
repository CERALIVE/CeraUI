import { logger } from "../../helpers/logger.ts";
import { nmConnSetFields } from "../network/network-manager.ts";
import { readNmProfileInstance } from "../network/network-manager-profile-instance.ts";
import type { DeviceLockResult } from "../network/state/device-lock.ts";
import {
	clearHotspotProfileCreation,
	getHotspotCredentialOwners,
	getHotspotCredentials,
	getPendingHotspotCreation,
	getPendingHotspotCreationInstance,
	pruneAbsentHotspotHistory,
} from "./hotspot-credentials.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterPolicyLocks,
} from "./wifi-adapter-lock.ts";
import {
	getPersistedWifiAdapterMode,
	persistWifiAdapterMode,
} from "./wifi-adapter-mode.ts";
import {
	bindWifiAdapterOwner,
	revokeWifiAdapterOwner,
} from "./wifi-adapter-owner.ts";
import type { WifiPolicyObservation } from "./wifi-adapter-reconciler.ts";
import { uniqueHotspotAddress } from "./wifi-autoconnect-policy.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import {
	nmDisconnectActivation,
	observeHotspotActivation,
} from "./wifi-hotspot-activity.ts";
import { observeHotspotProfile } from "./wifi-hotspot-profile-observation.ts";
import {
	type HotspotProfileOperation,
	readHotspotProfilePins,
	runHotspotProfileOperation,
	writeHotspotProfileFields,
} from "./wifi-hotspot-profile-operation.ts";
import { canHotspot } from "./wifi-hotspot-types.ts";
import { sampleWifiOperationRadio } from "./wifi-operation-binding.ts";
import {
	normalizeMacAddress,
	wifiAdapterKeyPort,
} from "./wifi-permanent-mac.ts";
import {
	radioInventoryFor,
	sameRadioLifetime,
	wifiPhysicalPortWitnesses,
} from "./wifi-radio-identity.ts";
import { literalWifiDevicePath } from "./wifi-radio-read-budget.ts";

function skipConflictingPins(): undefined {
	logger.warn(
		"Skipping hotspot policy mutation: conflicting or unknown profile pins",
		{ code: "wifi-hotspot-policy-pin-conflict" },
	);
	return undefined;
}

/** Checked profile actions; the reconciler owns serialization, health and retries. */
export async function applyHotspotProfilePolicy(
	owner: string,
	observation: WifiPolicyObservation,
): Promise<DeviceLockResult<string | undefined>> {
	const readInventory =
		observation.readInventory ?? radioInventoryFor(observation.identities);
	const heldKey = wifiAdapterLockKey(owner);
	const stored = getHotspotCredentials(owner);
	const pendingCreation = getPendingHotspotCreation(owner);
	const uuids = new Set([
		...(stored?.conn ? [stored.conn] : []),
		...(stored?.previousConns ?? []),
		...(pendingCreation ? [pendingCreation] : []),
	]);
	const write = observation.write ?? nmConnSetFields;
	const mac = normalizeMacAddress(owner.split("@")[0]);
	const intent = getPersistedWifiAdapterMode(owner);
	const station = observation.station || intent === "station";
	const healthyTwins =
		mac !== undefined &&
		owner === mac &&
		new Set(
			[...observation.identities.values()]
				.filter(
					(row) =>
						row.classification === "verified" &&
						row.permanentMac === mac &&
						!row.ifname.startsWith("clap-"),
				)
				.map((row) => row.lifetime?.phyPath),
		).size > 1;
	for (const uuid of uuids) {
		const profile = await observeHotspotProfile(uuid);
		switch (profile.kind) {
			case "absent":
				clearHotspotProfileCreation(owner, uuid);
				pruneAbsentHotspotHistory(owner, uuid);
				continue;
			case "unreadable":
				return { success: true, result: `could not read ${uuid}` };
			case "replaced":
				if (healthyTwins)
					return {
						success: true,
						result: `could not verify autoconnect for ${uuid}`,
					};
				continue;
			case "read":
				break;
		}
		if (profile.mode !== "ap") continue;
		if (
			healthyTwins &&
			profile.autoconnect !== "yes" &&
			profile.autoconnect !== "no"
		)
			return {
				success: true,
				result: `could not verify autoconnect for ${uuid}`,
			};
		const owners = getHotspotCredentialOwners(uuid);
		if (!owners.includes(owner)) continue;
		const resolved = owners.length === 1;
		const failedFirstStart =
			profile.firstStart && intent !== "hotspot" && intent !== "hybrid";
		let creationInstance = getPendingHotspotCreationInstance(owner);
		const act = async (
			operation: HotspotProfileOperation,
		): Promise<boolean | undefined> => {
			const result = await runHotspotProfileOperation(
				operation,
				profile.firstStart
					? {
							instance: creationInstance,
							readProfileInstance: readNmProfileInstance,
							owner,
						}
					: undefined,
			);
			creationInstance = result.instance ?? undefined;
			return result.checked ? result.success : undefined;
		};
		if (failedFirstStart && !resolved)
			return {
				success: true,
				result: `could not resolve first-start owner ${uuid}`,
			};
		const hybrid = profile.ifname.startsWith("clap-");
		const pin = normalizeMacAddress(profile.mac);
		const pathPin = literalWifiDevicePath(profile.path);
		const radios = wifiPhysicalPortWitnesses(observation.identities);
		const candidates = radios.filter((row) => {
			if (row.ifname.startsWith("clap-")) return false;
			const pinnedIfname = hybrid ? profile.ifname.slice(5) : profile.ifname;
			if (
				(pinnedIfname && row.ifname !== pinnedIfname) ||
				(pathPin && row.devicePath && pathPin !== row.devicePath) ||
				(row.permanentMac && row.permanentMac !== mac) ||
				(pin && row.permanentMac && pin !== row.permanentMac)
			) {
				revokeWifiAdapterOwner(row.ifname, owner, uuid);
				return false;
			}
			return (
				row.permanentMac === mac ||
				row.ifname === pinnedIfname ||
				observation.active.get(row.ifname) === uuid ||
				observation.active.get(`clap-${row.ifname}`) === uuid ||
				(row.permanentMac === undefined && pinnedIfname === "")
			);
		});
		const targets = new Set(
			Object.values(getWifiInterfacesByMacAddress()).filter(
				(row) =>
					candidates.some((candidate) => candidate.ifname === row.ifname) ||
					observation.active.get(row.ifname) === uuid ||
					observation.active.get(
						row.concurrentHotspot?.ifname ?? `clap-${row.ifname}`,
					) === uuid ||
					(canHotspot(row) && row.hotspot.conn === uuid),
			),
		);
		const applied = await withWifiAdapterPolicyLocks(
			heldKey,
			targets,
			async () => {
				const ownedPort = wifiAdapterKeyPort(owner);
				// This pass clears its own active observation after a successful Down.
				const activeBefore = new Set(
					[...observation.active]
						.filter(([, active]) => active === uuid)
						.map(([ifname]) => ifname),
				);
				const vacantPort = Boolean(
					pathPin && !radios.some((row) => row.devicePath === pathPin),
				);
				let requiresInventory = vacantPort;
				let refusedPins = false;
				const inventoryCurrent = () => {
					const current = !requiresInventory || readInventory.current();
					if (!current) refusedPins = true;
					return current;
				};
				const ownsPins = async () => {
					const currentOwners = getHotspotCredentialOwners(uuid);
					if (
						currentOwners.length !== 1 ||
						currentOwners[0] !== owner ||
						(profile.mac && (!pin || pin !== mac)) ||
						(profile.path && !pathPin)
					)
						return false;
					if (!pathPin) return true;
					if (
						ownedPort &&
						pathPin !== ownedPort &&
						!candidates.some(
							(row) =>
								row.permanentMac === mac &&
								row.devicePath === pathPin &&
								row.lifetime?.phyPath.split("/").at(-1) === ownedPort,
						)
					)
						return false;
					const occupant = radios.find((row) => row.devicePath === pathPin);
					if (!occupant)
						return (
							radios.every((row) => row.devicePath !== undefined) &&
							(await readInventory()).kind === "complete"
						);
					if (occupant.permanentMac !== undefined)
						return occupant.permanentMac === mac;
					// Station teardown can use the exact recorded AP witness on a
					// limited radio; it neither repins nor relies on vacant-port proof.
					return Boolean(
						station &&
							pin === mac &&
							candidates.includes(occupant) &&
							(activeBefore.has(occupant.ifname) ||
								(observation.active.size === 0 &&
									[...targets].some(
										(row) =>
											row.ifname === occupant.ifname &&
											canHotspot(row) &&
											row.hotspot.conn === uuid,
									))),
					);
				};
				if (!(await ownsPins()))
					return profile.autoconnect === "yes" || failedFirstStart || station
						? skipConflictingPins()
						: undefined;
				if (candidates.length === 1 && resolved)
					for (const candidate of candidates)
						bindWifiAdapterOwner(candidate.ifname, owner, {
							uuid,
							pinsMatch:
								(!profile.path || candidate.devicePath === profile.path) &&
								(!profile.mac ||
									(pin !== undefined && candidate.permanentMac === pin)),
						});
				if (station || failedFirstStart) {
					const activeIfnames = [...observation.active]
						.filter(([, active]) => active === uuid)
						.flatMap(([ifname]) => (ifname ? [ifname] : []));
					const port = wifiAdapterKeyPort(owner);
					const eligible = candidates.filter(
						(candidate) =>
							(!port || candidate.devicePath === port) &&
							(candidate.permanentMac === mac ||
								(!candidate.permanentMac &&
									candidates.length === 1 &&
									(!pathPin || candidate.devicePath === pathPin))),
					);
					const owned = activeIfnames.filter((ifname) =>
						eligible.some((candidate) => {
							if (ifname !== (hybrid ? profile.ifname : candidate.ifname))
								return false;
							const parentPhy = candidate.lifetime?.phyPath;
							return (
								!hybrid ||
								(parentPhy !== undefined &&
									observation.identities.get(ifname)?.lifetime?.phyPath ===
										parentPhy)
							);
						}),
					);
					if (resolved && owned.length === 1) {
						const ifname = owned[0];
						if (ifname === undefined) return undefined;
						const disconnected = await act({
							uuid,
							kind: "down",
							run: async () => {
								const lifetime = observation.identities.get(ifname)?.lifetime;
								return nmDisconnectActivation(
									uuid,
									await observeHotspotActivation(uuid, ifname),
									undefined,
									async () =>
										sameRadioLifetime(
											lifetime,
											(await sampleWifiOperationRadio(ifname))?.lifetime,
										) && inventoryCurrent(),
									requiresInventory ? inventoryCurrent : undefined,
								);
							},
						});
						if (refusedPins) return skipConflictingPins();
						if (disconnected === undefined) return undefined;
						if (!disconnected) return `could not deactivate ${uuid}`;
						observation.active.set(ifname, null);
					}
				} else {
					if (profile.autoconnect !== "yes") return undefined;
					const phys = new Set(
						[...observation.identities.values()]
							.filter((row) => row.permanentMac === mac)
							.map((row) => row.lifetime?.phyPath),
					);
					if (
						candidates.some((row) => row.classification !== "verified") &&
						phys.size < 2
					)
						return undefined;
					const identity = candidates.find(
						(row) => row.classification === "verified",
					);
					if (
						!hybrid &&
						mac &&
						identity?.devicePath &&
						profile.mac.toLowerCase() === mac &&
						profile.path === identity.devicePath
					) {
						const uniqueness = await uniqueHotspotAddress(mac, readInventory);
						if (uniqueness === "unknown") return skipConflictingPins();
						if (uniqueness === "proven-unique") return undefined;
						// Recheck freshness at dispatch, without reading iw a second time.
						requiresInventory = true;
					}
					if (getPersistedWifiAdapterMode(owner) === undefined) {
						try {
							persistWifiAdapterMode(owner, hybrid ? "hybrid" : "hotspot");
						} catch (error: unknown) {
							return `intent persistence ${error instanceof Error ? error.name : "failed"}`;
						}
					}
				}
				if (profile.autoconnect === "yes" || failedFirstStart) {
					const permitDisarm = async () => {
						const live = await readHotspotProfilePins(uuid);
						if (!live) return false;
						refusedPins =
							live[0].toLowerCase() !== profile.mac.toLowerCase() ||
							live[1] !== profile.path ||
							!(await ownsPins());
						// An owned profile's old port may be disarmed, never repinned here.
						return !refusedPins && inventoryCurrent;
					};
					const disabled = await act({
						uuid,
						kind: "modify",
						fields: { "connection.autoconnect": "no" },
						run: (fields) =>
							writeHotspotProfileFields(write, uuid, fields, permitDisarm),
					});
					if (refusedPins) return skipConflictingPins();
					if (disabled === undefined && !healthyTwins) return undefined;
					if (!disabled) return `could not disable ${uuid}`;
					if (healthyTwins) {
						const observed = await observeHotspotProfile(uuid);
						if (
							observed.kind !== "absent" &&
							(observed.kind !== "read" || observed.autoconnect !== "no")
						)
							return `could not verify autoconnect is disabled for ${uuid}`;
					}
				}
				if (failedFirstStart) clearHotspotProfileCreation(owner, uuid);
				return undefined;
			},
		);
		if (!applied.success || applied.result !== undefined) return applied;
	}
	return { success: true, result: undefined };
}
