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
	clearHotspotProfileCreation,
	getHotspotCredentialOwners,
	getPendingHotspotCreation,
	getPendingHotspotCreationInstance,
	recordHotspotProfileCreation,
} from "./hotspot-credentials.ts";
import {
	getPendingHotspotProfile,
	recordPendingHotspotModify,
} from "./wifi-hotspot-monitor.ts";
import { retireHotspotProfileAuthority } from "./wifi-hotspot-profile-observation.ts";
import { classifyHotspotProfileReadback } from "./wifi-hotspot-profile-readback.ts";

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
				readonly run: () => Promise<unknown>;
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
	const dispatch = () =>
		operation.kind === "modify" ? operation.run(fields) : operation.run();
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
				success: Boolean(await dispatch()),
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
			acknowledged = Boolean(await dispatch());
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
