import {
	describeObservationFailure,
	MAX_DETAIL,
} from "./os-stage-admission-diagnostics.ts";
import { OsStageError, type OsStageFailureReason } from "./os-stage-error.ts";

export type OsStageFailureStep =
	| "admission"
	| "runner"
	| "settlement-proof"
	| "startup-recovery";
type FirstFailure = {
	readonly firstFailureStep: OsStageFailureStep;
	readonly firstFailureReason: OsStageFailureReason | "untyped";
	readonly firstFailurePredicate: StageFailurePredicate;
	readonly firstFailureObservation?: string;
	readonly firstFailureAttempts?: number;
	readonly firstFailureElapsedMs?: number;
};
type FailureContext = FirstFailure & {
	readonly failureStep: OsStageFailureStep;
	readonly predicate: StageFailurePredicate;
	readonly observation?: string;
	readonly attempts?: number;
	readonly elapsedMs?: number;
};
const contexts = new WeakMap<object, FailureContext>();
const predicates = [
	"observation-unknown",
	"daemon-inactive",
	"operation-not-idle",
	"resources-present",
	"extra-process",
	"booted-unhealthy",
	"target-not-inactive",
	"boot-primary-unknown",
	"boot-primary-not-booted",
	"boot-primary-is-target",
	"activation-armed",
	"baseline-changed:bootId",
	"baseline-changed:bootPrimary",
	"baseline-changed:bootedSlot",
	"baseline-changed:bootedDevice",
	"baseline-changed:targetSlot",
	"baseline-changed:targetDevice",
	"cli-unsettled",
	"lock-owner-unproven",
	"daemon-not-ready",
	"old-daemon-instance",
	"old-installer-survives",
	"installer-ownership-unproven",
	"owned-resource-survives",
	"resource-ownership-unproven",
	"activation-identity-unproven-or-changed",
	"booted-slot-changed-or-unhealthy",
	"unlaunched-provenance-unproven",
	"deadline-expired",
	"daemon-identity-changed",
	"authority-refused",
	"observation-thrown",
	"quiescence-thrown",
	"live-producer-conflict",
	"foreign-or-unrecorded-guardian",
	"signed-candidate-expired",
] as const;
type StageFailurePredicate = (typeof predicates)[number];
const stages = new Set([
	"service-command",
	"service-properties",
	"daemon-process",
	"cgroup-processes",
	"block-inventory",
	"nbd-pid",
	"nbd-process",
	"nbd-cgroup",
	"dm-identity",
	"dm-slaves",
	"mountinfo",
	"operation-command",
	"status-command",
	"status-parse",
	"slot-cardinality",
	"boot-id",
	"healthy-state",
	"booted-device",
	"root-device",
	"activation-marker",
	"target-device",
	"final-service-command",
	"census-drift",
	"observation",
	"quiescence",
	"admission",
	"runner",
	"settlement-proof",
	"startup-recovery",
	...predicates,
]);

function boundedObservation(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > MAX_DETAIL) return undefined;
	const separator = value.indexOf(": ");
	if (!stages.has(value.slice(0, separator))) return undefined;
	return /^(?:unproven|unknown-error|thrown (?:object|string|number|boolean|undefined|symbol|bigint|function)|(?:Error|TypeError|SyntaxError|RangeError|ZodError|SpawnTimeoutError)(?:\((?:ENOENT|ESRCH|EACCES|EPERM|EIO|ENOTDIR|ELOOP|ETIMEDOUT|EROFS)\))?:)$/.test(
		value.slice(separator + 2),
	)
		? value
		: undefined;
}

export function stageFailureContext(
	error: unknown,
): FailureContext | undefined {
	return typeof error === "object" && error !== null
		? contexts.get(error)
		: undefined;
}

/** In-memory evidence only: keep thrown identity/cause and every safety decision unchanged. */
export function recordStageFailure(
	error: unknown,
	step: OsStageFailureStep,
	detail: {
		readonly predicate?: string;
		readonly observation?: string;
		readonly attempts?: number;
		readonly elapsedMs?: number;
		readonly first?: unknown;
	} = {},
): void {
	if (typeof error !== "object" || error === null) return;
	const diagnostics = error instanceof OsStageError ? error.diagnostics : {};
	const rawPredicate =
		detail.predicate ?? diagnostics.predicate ?? diagnostics.refusal;
	const predicate =
		predicates.find((value) => value === rawPredicate) ?? "observation-unknown";
	const observation = boundedObservation(
		detail.observation ??
			diagnostics.observation ??
			(error instanceof OsStageError
				? error.cause instanceof Error
					? describeObservationFailure(step, error.cause)
					: undefined
				: describeObservationFailure(step, error)),
	);
	const previous =
		stageFailureContext(detail.first) ?? stageFailureContext(error);
	const first: FirstFailure = previous
		? {
				firstFailureStep: previous.firstFailureStep,
				firstFailureReason: previous.firstFailureReason,
				firstFailurePredicate: previous.firstFailurePredicate,
				...(previous.firstFailureObservation
					? { firstFailureObservation: previous.firstFailureObservation }
					: {}),
				...(previous.firstFailureAttempts === undefined
					? {}
					: { firstFailureAttempts: previous.firstFailureAttempts }),
				...(previous.firstFailureElapsedMs === undefined
					? {}
					: { firstFailureElapsedMs: previous.firstFailureElapsedMs }),
			}
		: {
				firstFailureStep: step,
				firstFailureReason:
					error instanceof OsStageError ? error.reason : "untyped",
				firstFailurePredicate: predicate,
				...(observation ? { firstFailureObservation: observation } : {}),
				...(detail.attempts === undefined
					? {}
					: { firstFailureAttempts: detail.attempts }),
				...(detail.elapsedMs === undefined
					? {}
					: { firstFailureElapsedMs: detail.elapsedMs }),
			};
	contexts.set(error, {
		...first,
		failureStep: step,
		predicate,
		...(observation ? { observation } : {}),
		...(detail.attempts === undefined ? {} : { attempts: detail.attempts }),
		...(detail.elapsedMs === undefined ? {} : { elapsedMs: detail.elapsedMs }),
	});
}

export function inheritStageFailure(error: object, cause: unknown): void {
	const context = stageFailureContext(cause);
	if (context) contexts.set(error, context);
}
