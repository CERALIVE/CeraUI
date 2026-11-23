import { logger } from "../../helpers/logger.ts";
import type { NmProfileInstance } from "./network-manager-profile-instance.ts";
import { readNmVersionId } from "./network-manager-profile-write.ts";

/** Metadata belongs to the existing receipt; symbols never enter its persisted JSON. */
export const nmProfileObservation = Symbol("nm-profile-observation");

export type NmProfileStat = {
	readonly dev: string;
	readonly inode: string;
	readonly size: string;
	readonly mtime_ns: string;
	readonly ctime_ns: string;
};

/** Mutable only while one bounded snapshot is being collected. Digests are never logged. */
export type NmProfileReadTrace = {
	path?: string | null | undefined;
	afterPath?: string | null | undefined;
	exit?: string;
	firstStat?: NmProfileStat | null;
	secondStat?: NmProfileStat | null;
	fdStat?: NmProfileStat | null;
	pathStat?: NmProfileStat | null;
	fileReason?: string;
	fileReceiptPresent?: boolean;
	fieldDigests?: Readonly<Record<string, string>>;
	submittedChanges?: readonly string[];
	submittedFieldCount?: number;
	pathChanged?: boolean;
	runChanged?: boolean;
	activationTimestamp?: string;
};

const receiptStat = (instance: NmProfileInstance | null | undefined) =>
	instance?.file
		? {
				dev: instance.file.device,
				inode: instance.file.inode,
				size: null,
				mtime_ns: null,
				ctime_ns: instance.file.ctime,
			}
		: null;

/** A single whitelisted WARN record, only after an authority-retiring decision. */
export async function warnNmProfileRetirement(
	exit: string,
	before: NmProfileInstance | null | undefined,
	after: NmProfileInstance | null | undefined,
	trace?: NmProfileReadTrace,
	requestedFields: readonly string[] = [],
): Promise<void> {
	const prior = before?.[nmProfileObservation];
	const current = trace ?? after?.[nmProfileObservation];
	const a = prior?.fieldDigests;
	const b = current?.fieldDigests;
	const compared = a && b ? Object.keys(a).filter((name) => name in b) : [];
	const submitted = current?.submittedFieldCount !== undefined;
	const changedFields = submitted
		? (current?.submittedChanges ?? [])
		: a && b
			? compared.filter((name) => a[name] !== b[name]).sort()
			: null;
	const path =
		after?.path ?? current?.afterPath ?? current?.path ?? before?.path;
	const version =
		path && /^\/org\/freedesktop\/NetworkManager\/Settings\/\d+$/.test(path)
			? await readNmVersionId(path)
			: undefined;
	const missing =
		current?.fileReceiptPresent === undefined
			? !after?.file
			: !current.fileReceiptPresent;
	logger.warn("Wi-Fi profile authority retired", {
		exit,
		readExit: current?.exit ?? null,
		changedFields,
		fieldComparisonAvailable: submitted || Boolean(a && b),
		comparedFieldCount: current?.submittedFieldCount ?? compared.length,
		fieldComparisonScope: submitted
			? "submitted-nm-settings"
			: "selected-nm-settings",
		requestedFields,
		fileReceiptMissing: missing || Boolean(current?.fileReason),
		fileReceiptReason:
			current?.fileReason ??
			(missing ? (after === null ? "profile-absent" : "unavailable") : null),
		stats: {
			before: {
				first: prior?.firstStat ?? receiptStat(before),
				second: prior?.secondStat ?? receiptStat(before),
			},
			after: {
				first: current?.firstStat ?? receiptStat(after),
				second: current?.secondStat ?? receiptStat(after),
				fd: current?.fdStat ?? null,
				path: current?.pathStat ?? null,
			},
		},
		pathChanged:
			current?.pathChanged === true
				? true
				: before && after
					? before.path !== after.path
					: (current?.pathChanged ?? null),
		runChanged:
			current?.runChanged === true
				? true
				: before && after
					? before.runId !== after.runId
					: (current?.runChanged ?? null),
		filenameChanged:
			before?.file && after?.file
				? before.file.filename !== after.file.filename
				: null,
		versionId: version?.toString() ?? null,
	});
}
