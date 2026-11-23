import { nmConnGetFields } from "../network/network-manager.ts";
import {
	type NmProfileReadTrace,
	nmProfileObservation,
	warnNmProfileRetirement,
} from "../network/network-manager-profile-diagnostics.ts";
import {
	type NmProfileInstance,
	readNmProfileInstance,
	sameNmProfileResource,
} from "../network/network-manager-profile-instance.ts";
import { openNmProfileFile } from "../network/network-manager-profile-write.ts";
import { serializeNmProfileModify } from "../network/network-manager-secret.ts";
import {
	type ProfileWriteAdmission,
	type ProfileWritePermit,
	profileWritePermit,
} from "../network/profile-write-permit.ts";
import {
	clearHotspotProfileCreation,
	getHotspotCredentialOwners,
	getPendingHotspotCreation,
	getPendingHotspotCreationInstance,
	recordHotspotProfileCreation,
} from "./hotspot-credentials.ts";
import { uniqueHotspotAddress } from "./wifi-autoconnect-policy.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import {
	getPendingHotspotProfile,
	recordPendingHotspotModify,
} from "./wifi-hotspot-monitor.ts";
import { retireHotspotProfileAuthority } from "./wifi-hotspot-profile-observation.ts";
import { classifyHotspotProfileReadback } from "./wifi-hotspot-profile-readback.ts";
import type {
	HotspotActivationDeps,
	HotspotProfilePins,
} from "./wifi-hotspot-types.ts";
import {
	ownsWifiOperation,
	type WifiOperationBinding,
} from "./wifi-operation-binding.ts";
import {
	normalizeMacAddress,
	wifiAdapterKeyMac,
} from "./wifi-permanent-mac.ts";
import {
	radioInventoryFor,
	wifiPhysicalPortWitnesses,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import { literalWifiDevicePath } from "./wifi-radio-read-budget.ts";

export function readHotspotProfilePins(uuid: string) {
	return nmConnGetFields(
		uuid,
		[
			"802-11-wireless.mac-address",
			"match.path",
			"connection.autoconnect",
		] as const,
		undefined,
		false,
	);
}

export async function permitsHotspotProfilePins(
	uuid: string,
	mac: string,
	port: string | undefined,
	read?: HotspotActivationDeps["readProfilePins"],
	compatibleLegacyMac?: (mac: string) => Promise<boolean>,
): Promise<boolean> {
	if (!read) return true; // Injected, non-NM activation dependencies own their writes.
	const pins = await read(uuid);
	return Boolean(
		pins &&
			(!pins[0] ||
				normalizeMacAddress(pins[0]) === mac ||
				(await compatibleLegacyMac?.(pins[0]))) &&
			(!pins[1] || pins[1] === port),
	);
}

type SavedPinAdmission = {
	readonly kind: "write" | "keep-policy" | "activate-only" | "refuse";
	readonly current?: () => boolean;
};

export function canWriteSavedHotspotPins(
	admission: false | SavedPinAdmission,
): ProfileWriteAdmission {
	return admission &&
		(admission.kind === "write" || admission.kind === "keep-policy")
		? (admission.current ?? true)
		: false;
}

/** A legacy MAC may be replaced only after ruling out both live and saved owners. */
export async function legacyHotspotMacClaim(
	rawMac: string,
	readInventory = radioInventoryFor(),
): Promise<"proven-unclaimed" | "proven-claimed" | "unknown"> {
	const mac = normalizeMacAddress(rawMac);
	if (!mac) return "unknown";
	const inventory = await readInventory();
	if (inventory.kind === "unknown") return "unknown";
	const physical = wifiPhysicalPortWitnesses(inventory.rows);
	if (
		physical.some((radio) => radio.permanentMac === mac) ||
		[
			...Object.keys(getWifiInterfacesByMacAddress()),
			...getHotspotCredentialOwners(),
		].some((key) => wifiAdapterKeyMac(key) === mac)
	)
		return "proven-claimed";
	return physical.some((radio) => radio.permanentMac === undefined)
		? "unknown"
		: "proven-unclaimed";
}

/** Start may repair a recorded pin, not adopt a new pin observed mid-write. */
export function savedHotspotStartPinGuard(
	owner: string,
	mac: string,
	port: string | undefined,
	read: HotspotActivationDeps["readProfilePins"],
	binding: WifiOperationBinding | undefined,
) {
	let initial:
		| { readonly uuid: string; readonly pins: HotspotProfilePins }
		| undefined;
	return async (
		uuid: string,
		observedMac?: string,
	): Promise<SavedPinAdmission> => {
		if (!read) return { kind: "write" };
		const pins = await read(uuid);
		if (!pins) return { kind: "refuse" };
		initial ??= { uuid, pins };
		const [rawMac, livePort, autoconnect] = pins;
		const liveMac = normalizeMacAddress(rawMac);
		const macMatches = !rawMac || liveMac === mac;
		const portMatches = !livePort || livePort === port;
		if (macMatches && portMatches)
			return liveMac === mac && livePort && initial.pins[1] === livePort
				? { kind: "keep-policy" }
				: { kind: "write" };
		if (
			initial.uuid !== uuid ||
			initial.pins[0] !== rawMac ||
			initial.pins[1] !== livePort
		)
			return { kind: "refuse" };
		const owners = getHotspotCredentialOwners(uuid);
		if (owners.length !== 1 || owners[0] !== owner) return { kind: "refuse" };
		const radios = wifiRadioIdentity.state.rows;
		const inventory = radioInventoryFor(radios);
		if (!macMatches)
			return portMatches &&
				liveMac !== undefined &&
				liveMac === normalizeMacAddress(observedMac) &&
				(await legacyHotspotMacClaim(rawMac, inventory)) === "proven-unclaimed"
				? { kind: "write", current: inventory.current }
				: { kind: "refuse" };
		if (
			liveMac !== mac ||
			owner !== mac ||
			!literalWifiDevicePath(livePort) ||
			!binding ||
			!ownsWifiOperation(binding)
		)
			return { kind: "refuse" };
		const physical = wifiPhysicalPortWitnesses(radios);
		// NM can attempt the existing binding without us guessing or changing it.
		if (
			port === undefined &&
			physical.length === 1 &&
			physical[0]?.ifname === binding.ifname
		) {
			if ((await inventory()).kind === "complete" && ownsWifiOperation(binding))
				return { kind: "activate-only", current: inventory.current };
			return { kind: "refuse" };
		}
		// An exact MAC, unique bound owner and quiesced unused port prove a move,
		// not a new claim on an unpinned or same-MAC twin's profile.
		return autoconnect === "no" &&
			binding.devicePath &&
			(await uniqueHotspotAddress(mac, inventory)) === "proven-unique" &&
			physical.every(
				(radio) =>
					radio.devicePath !== undefined && radio.devicePath !== livePort,
			)
			? { kind: "write", current: inventory.current }
			: { kind: "refuse" };
	};
}

/** Check before entering the writer and again at its actual dispatch boundary. */
export async function writeHotspotProfileFields(
	write: (
		uuid: string,
		fields: Record<string, string>,
		permit?: ProfileWritePermit,
	) => Promise<unknown>,
	uuid: string,
	fields: Record<string, string>,
	permit: () => Promise<ProfileWriteAdmission>,
): Promise<boolean> {
	const guarded = profileWritePermit(permit);
	return (
		(await guarded()) &&
		guarded.current?.() !== false &&
		Boolean(await write(uuid, fields, guarded))
	);
}

type ProfileOperationTarget = {
	readonly uuid: string;
	/** Explicit connection commands retain their existing selected-target authority. */
	readonly selected?: boolean;
};
export type HotspotProfileOperation = ProfileOperationTarget &
	(
		| {
				readonly kind: "modify";
				readonly fields: Readonly<Record<string, string>>;
				readonly run: (
					fields: Readonly<Record<string, string>>,
				) => Promise<unknown>;
		  }
		| {
				readonly kind: "add" | "up" | "down" | "delete";
				readonly run: (before?: NmProfileInstance | null) => Promise<unknown>;
		  }
	);

export type HotspotProfileEvidence = {
	readonly instance: NmProfileInstance | null | undefined;
	readonly readProfileInstance?: typeof readNmProfileInstance | undefined;
	readonly recordCreation?: typeof recordHotspotProfileCreation | undefined;
	readonly owner?: string;
	/** Saved-profile adapters may omit snapshots; this never downgrades a captured receipt. */
	readonly optional?: boolean;
};

export type HotspotProfileOperationResult = {
	readonly success: boolean;
	readonly checked: boolean;
	readonly instance: NmProfileInstance | null | undefined;
};

/** One operation classification and readback path; retained evidence stays in its existing owners. */
export async function runHotspotProfileOperation(
	operation: HotspotProfileOperation,
	evidence?: HotspotProfileEvidence,
): Promise<HotspotProfileOperationResult> {
	const { uuid, kind } = operation;
	const fields = Object.freeze(
		kind === "modify" ? { ...operation.fields } : {},
	);
	const dispatch = (before?: NmProfileInstance | null) =>
		operation.kind === "modify" ? operation.run(fields) : operation.run(before);
	const owners = getHotspotCredentialOwners(uuid);
	const bound = owners.flatMap((owner) => {
		const instance = getPendingHotspotCreationInstance(owner);
		return getPendingHotspotCreation(owner) === uuid && instance
			? [{ owner, instance }]
			: [];
	});
	const pending = getPendingHotspotProfile(uuid);
	const read = evidence
		? evidence.readProfileInstance
		: owners.length || pending
			? readNmProfileInstance
			: undefined;
	if (!read)
		return {
			success: Boolean(await dispatch()),
			checked: true,
			instance: evidence?.instance,
		};

	let readTrace: NmProfileReadTrace = {};
	let warningBefore: NmProfileInstance | null | undefined;
	let warningAfter: NmProfileInstance | null | undefined;
	let exit = `before-${kind}`;
	const observe = async () => {
		const trace: NmProfileReadTrace = {};
		const instance = await read(uuid, undefined, trace);
		readTrace = instance?.[nmProfileObservation] ?? trace;
		return instance;
	};
	const retire = async (gone: boolean): Promise<void> => {
		for (const owner of new Set([
			...owners,
			...(evidence?.owner ? [evidence.owner] : []),
		])) {
			if (gone) clearHotspotProfileCreation(owner, uuid);
			else retireHotspotProfileAuthority(owner, uuid);
		}
		await warnNmProfileRetirement(
			exit,
			warningBefore,
			warningAfter,
			readTrace,
			Object.keys(fields),
		);
	};
	// Add targets a newly minted UUID reserved by its pre-dispatch creation hook.
	const before = kind === "add" ? null : await observe();
	// An earlier owned modify may already have updated this creation's canonical receipt.
	const canonical = evidence?.owner
		? bound.find(
				(entry) =>
					entry.owner === evidence.owner &&
					sameNmProfileResource(entry.instance, before),
			)?.instance
		: undefined;
	let expected = evidence
		? (canonical ?? evidence.instance)
		: (bound[0]?.instance ?? pending ?? before);
	if (
		evidence?.optional &&
		!evidence.instance?.file &&
		bound.length === 0 &&
		!pending
	) {
		if (!before?.file)
			return {
				success: Boolean(await dispatch(before)),
				checked: true,
				instance: undefined,
			};
		expected = before;
	}
	const eligible =
		kind === "add" ? before === null : sameNmProfileResource(expected, before);
	const staleBinding = bound.some(
		(entry) => !sameNmProfileResource(entry.instance, before),
	);
	warningBefore = expected;
	warningAfter = before;
	if (!eligible || staleBinding) {
		await retire(before === null);
		if (!operation.selected || kind === "modify")
			return {
				success: false,
				checked: false,
				instance: before === null ? null : undefined,
			};
	}

	let held: Awaited<ReturnType<typeof openNmProfileFile>>;
	try {
		let predicted: Buffer | undefined;
		if (kind !== "add") {
			exit = `${kind}-file-precheck`;
			held = await openNmProfileFile(before?.file, readTrace);
			if (!held && (!operation.selected || kind === "modify")) {
				await retire(before === null);
				return { success: false, checked: false, instance: undefined };
			}
		}
		if (kind === "modify") {
			if (!held) throw new TypeError("Missing verified modify file");
			try {
				predicted = Buffer.from(
					await serializeNmProfileModify(held.bytes.toString(), fields),
				);
			} catch (error: unknown) {
				if (!(error instanceof Error)) throw error;
				return { success: false, checked: true, instance: before };
			}
			if (predicted.equals(held.bytes)) {
				exit = "modify-noop-readback";
				const after = await observe();
				warningBefore = before;
				warningAfter = after;
				const checked = sameNmProfileResource(before, after);
				if (!checked) await retire(after === null);
				return {
					success: checked,
					checked,
					instance: checked ? before : undefined,
				};
			}
			// VersionId is diagnostic only: NM can activate outside the adapter lock.
		}
		let acknowledged = false;
		let checked = false;
		let instance: NmProfileInstance | null | undefined;
		try {
			acknowledged = Boolean(await dispatch(before));
		} finally {
			const after = await observe();
			exit = `after-${kind}`;
			warningBefore = before;
			warningAfter = after;
			const observed = await classifyHotspotProfileReadback(
				{ kind, before, held, predicted, acknowledged, fields },
				after,
				readTrace,
			);
			exit = observed.exit ?? exit;
			checked = observed.checked;
			instance = observed.instance;
			if (!checked) {
				await retire(kind !== "modify" && after === null);
				instance = after === null ? null : undefined;
			} else if (kind === "delete" && after === null) {
				for (const entry of bound)
					clearHotspotProfileCreation(entry.owner, uuid);
			} else if (kind === "modify" && acknowledged && instance) {
				const record = evidence?.recordCreation ?? recordHotspotProfileCreation;
				for (const entry of bound) {
					if (
						getPendingHotspotCreation(entry.owner) !== uuid ||
						!getPendingHotspotCreationInstance(entry.owner)
					)
						continue;
					if (!record(entry.owner, uuid, instance)) {
						exit = "modify-record-refused";
						await retire(false);
						checked = false;
						instance = undefined;
						break;
					}
				}
				if (checked && instance && !operation.selected)
					recordPendingHotspotModify(uuid, before, instance);
			}
		}
		return {
			success:
				acknowledged &&
				(kind === "modify" ? checked : operation.selected || checked),
			checked,
			instance,
		};
	} finally {
		await held?.handle.close();
	}
}
