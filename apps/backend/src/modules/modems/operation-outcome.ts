/**
 * Projection of `@ceralive/modem-control`'s operation vocabulary onto the wire.
 *
 * The package classifies a modem operation twice — once into a COMPLETION (what
 * the provider reported) and once into a RESULT (what that means after
 * generation fencing) — and separately maps a typed daemon/transport failure
 * onto one of eight stable refusal reasons. All three vocabularies are frozen,
 * and this module's whole job is to carry them across the RPC boundary WITHOUT
 * translating them into a per-procedure generic error.
 *
 * That collapse is the defect this exists to end: `modems.setUsbMode` answered a
 * thrown dependency with `transaction_error`, `modems.setFccUnlock` with
 * `write_failed`, and `modems.unlockSimPuk` with the bare string `error` — three
 * different words for "something failed", none of which tells an operator
 * whether to wait, re-authenticate, or stop trying. `mapModemManagerError` had
 * already answered that question and nothing was reading its answer.
 *
 * Package consumption goes through the existing `modem-control-compat.ts` seam
 * with a local fallback, the same shape every other projection module uses; the
 * fallbacks are behaviour mirrors, not stubs, so a release that stopped
 * exporting one degrades to the same verdict rather than to silence.
 */

import {
	MODEM_MANAGER_REFUSAL_RETRYABLE,
	type ModemManagerRefusalReason,
	type ModemOperationCompletionStatus,
	type ModemOperationOutcome,
	type ModemOperationUnknownReason,
	modemManagerRefusalReasonSchema,
} from "@ceraui/rpc/schemas";

import { modemControlFunction } from "../modem-control-compat.ts";

type PackageRefusal = {
	readonly reason: string;
	readonly retryable: boolean;
};

type PackageCompletion =
	| { readonly status: "applied"; readonly value: unknown }
	| { readonly status: "refused"; readonly reason: string }
	| { readonly status: "failed"; readonly reason: string }
	| { readonly status: "timed-out" }
	| { readonly status: "dropped" };

type PackageResult =
	| { readonly status: "applied"; readonly requiresReconciliation: false }
	| {
			readonly status: "refused";
			readonly reason: string;
			readonly requiresReconciliation: false;
	  }
	| {
			readonly status: "unknown-outcome";
			readonly reason: ModemOperationUnknownReason;
			readonly requiresReconciliation: true;
	  }
	| {
			readonly status: "failed";
			readonly reason: string;
			readonly requiresReconciliation: false;
	  };

/**
 * Mirror of `mapModemManagerError`, matched on the error's D-Bus name rather
 * than by `instanceof`.
 *
 * The package tests `error instanceof DisconnectedError` / `TransportError`,
 * which it can do because it owns both classes. A fallback that imported them
 * would defeat the point of being a fallback, and a cross-realm `instanceof` is
 * unreliable anyway, so the transport arms are recognised by `name` instead. The
 * regex arms and their order are reproduced exactly: the order IS the rule,
 * because several ModemManager errors match more than one pattern and the first
 * match is the one the package publishes.
 */
function mapModemManagerErrorFallback(error: unknown): PackageRefusal {
	if (!(error instanceof Error)) {
		return { reason: "failed", retryable: false };
	}

	if (error.name === "DisconnectedError") {
		return { reason: "disconnected", retryable: true };
	}

	const dbusName = Reflect.get(error, "dbusName");
	const identity = `${typeof dbusName === "string" ? dbusName : error.name} ${error.message}`;

	if (/Unauthorized|AccessDenied/i.test(identity)) {
		return { reason: "unauthorized", retryable: false };
	}
	if (/Unsupported|NotSupported/i.test(identity)) {
		return { reason: "unsupported", retryable: false };
	}
	if (/WrongState|InvalidState/i.test(identity)) {
		return { reason: "wrong-state", retryable: true };
	}
	if (/InProgress|Busy/i.test(identity)) {
		return { reason: "busy", retryable: true };
	}
	if (/NotFound|UnknownObject|UnknownModem/i.test(identity)) {
		return { reason: "not-found", retryable: false };
	}
	if (error.name === "TransportError" && /timed out/i.test(error.message)) {
		return { reason: "timed-out", retryable: true };
	}

	return { reason: "failed", retryable: false };
}

/**
 * Mirror of `classifyOperationCompletion`.
 *
 * Takes `staleGeneration` as a boolean rather than the two branded
 * `DeviceGeneration` values the package compares, because the caller has already
 * made that comparison and a fallback must not need the package's constructors
 * to answer. The three rules are otherwise verbatim: a stale generation is
 * `unknown-outcome` whatever the completion said; an unanswered WRITE is
 * `unknown-outcome`; the same unanswered READ is a plain `failed`.
 */
function classifyOperationCompletionFallback(
	completion: PackageCompletion,
	operation: "read" | "write",
	staleGeneration: boolean,
): PackageResult {
	if (staleGeneration) {
		return {
			status: "unknown-outcome",
			reason: "stale-generation",
			requiresReconciliation: true,
		};
	}

	switch (completion.status) {
		case "applied":
			return { status: "applied", requiresReconciliation: false };
		case "refused":
			return {
				status: "refused",
				reason: completion.reason,
				requiresReconciliation: false,
			};
		case "failed":
			return {
				status: "failed",
				reason: completion.reason,
				requiresReconciliation: false,
			};
		case "timed-out":
			return operation === "write"
				? {
						status: "unknown-outcome",
						reason: "write-reply-timed-out",
						requiresReconciliation: true,
					}
				: {
						status: "failed",
						reason: "read-reply-timed-out",
						requiresReconciliation: false,
					};
		case "dropped":
			return operation === "write"
				? {
						status: "unknown-outcome",
						reason: "write-reply-dropped",
						requiresReconciliation: true,
					}
				: {
						status: "failed",
						reason: "read-reply-dropped",
						requiresReconciliation: false,
					};
	}
}

const mapModemManagerErrorFn = modemControlFunction<
	(error: unknown) => PackageRefusal
>("mapModemManagerError", mapModemManagerErrorFallback);

const classifyOperationCompletionFn = modemControlFunction<
	(context: {
		operation: "read" | "write";
		completionGeneration: number;
		currentGeneration: number;
		completion: PackageCompletion;
	}) => PackageResult
>("classifyOperationCompletion", ({ operation, completion, ...generations }) =>
	classifyOperationCompletionFallback(
		completion,
		operation,
		generations.completionGeneration !== generations.currentGeneration,
	),
);

/**
 * Narrow the package's `reason` string to the frozen refusal enum.
 *
 * A refusal the package produced is always a member, so this can only reject a
 * value that did not come from `mapModemManagerError` — and answering
 * `undefined` there is deliberate: publishing `failed` (the package's own
 * fallback arm) for a reason the daemon never produced would put a daemon
 * verdict on screen for a CeraUI-side decision.
 */
function asRefusalReason(
	reason: string,
): ModemManagerRefusalReason | undefined {
	const parsed = modemManagerRefusalReasonSchema.safeParse(reason);
	return parsed.success ? parsed.data : undefined;
}

export function modemOperationApplied(): ModemOperationOutcome {
	return { status: "applied", completion: "applied", retryable: false };
}

/**
 * Project a thrown modem error into a typed refusal.
 *
 * This is the live path today: CeraUI does not run the package's operation
 * engine, so the classified outcome an RPC actually has to answer for is an
 * exception escaping a modem write. `completion` is `failed` because that is
 * what the provider reported — the error never reached the classifier — and the
 * REASON is the daemon's own verdict rather than the procedure's generic word
 * for it.
 */
export function modemOperationOutcomeFromError(
	error: unknown,
): ModemOperationOutcome {
	const refusal = mapModemManagerErrorFn(error);
	const reason = asRefusalReason(refusal.reason);

	return {
		status: "refused",
		completion: "failed",
		reason: refusal.reason,
		retryable: refusal.retryable,
		...(reason === undefined ? {} : { refusal: reason }),
	};
}

/**
 * Project a refusal CeraUI itself decided (a descriptor refusal, an unmet
 * precondition, a readback mismatch).
 *
 * `retryable` is `false` and that is a statement rather than a default: an
 * identical request re-issued against an identical CeraUI-side decision produces
 * an identical refusal, so offering a retry would waste an operator's time on a
 * verdict that cannot move. Only a daemon refusal carries a `retryable: true`,
 * because only the daemon is describing a device state that can clear on its own.
 */
export function modemOperationRefused(reason: string): ModemOperationOutcome {
	return {
		status: "refused",
		completion: "refused",
		reason,
		retryable: false,
	};
}

/**
 * Project a package `OperationCompletion` through the package's own classifier.
 *
 * The COMPLETION status rides the wire beside the classified RESULT because the
 * two answer different questions and one field cannot hold both — a `timed-out`
 * completion is `unknown-outcome` on a write and `failed` on a read, and a
 * consumer that only saw the result could not tell the write case from a
 * genuinely stale generation.
 */
export function classifyModemOperationOutcome(context: {
	readonly operation: "read" | "write";
	readonly completion: PackageCompletion;
	readonly completionGeneration: number;
	readonly currentGeneration: number;
}): ModemOperationOutcome {
	const completion: ModemOperationCompletionStatus = context.completion.status;
	const result = classifyOperationCompletionFn({
		operation: context.operation,
		completionGeneration: context.completionGeneration,
		currentGeneration: context.currentGeneration,
		completion: context.completion,
	});

	switch (result.status) {
		case "applied":
			return { status: "applied", completion: "applied", retryable: false };
		case "unknown-outcome":
			return {
				status: "unknown-outcome",
				completion,
				reason: result.reason,
				requires_reconciliation: true,
				retryable: false,
			};
		case "refused":
		case "failed": {
			const refusal = asRefusalReason(result.reason);
			return {
				status: result.status,
				completion,
				reason: result.reason,
				retryable:
					refusal === undefined
						? false
						: MODEM_MANAGER_REFUSAL_RETRYABLE[refusal],
				...(refusal === undefined ? {} : { refusal }),
			};
		}
	}
}

export const __testing = {
	mapModemManagerErrorFallback,
	classifyOperationCompletionFallback,
};
