import { describe, expect, test } from "bun:test";
import { MODEM_MANAGER_REFUSAL_REASONS } from "@ceralive/modem-control";
import {
	DisconnectedError,
	TransportError,
} from "@ceralive/modem-control/transport";
import {
	MODEM_MANAGER_REFUSAL_RETRYABLE,
	type ModemManagerRefusalReason,
	type ModemOperationCompletionStatus,
	type ModemOperationResultStatus,
	type ModemOperationUnknownReason,
	modemManagerRefusalReasonSchema,
	modemOperationCompletionStatusSchema,
	modemOperationOutcomeSchema,
	modemOperationResultStatusSchema,
	modemOperationUnknownReasonSchema,
} from "@ceraui/rpc/schemas";

import { hasModemControlFunction } from "../modules/modem-control-compat.ts";
import {
	__testing,
	classifyModemOperationOutcome,
	modemOperationApplied,
	modemOperationOutcomeFromError,
	modemOperationRefused,
} from "../modules/modems/operation-outcome.ts";

// The 20-value vocabulary subset this suite exists to pin, written out as
// literals rather than derived from the schemas — a test that reads its
// expectations out of the thing under test cannot detect a value going missing.
const COMPLETION_STATUSES: ModemOperationCompletionStatus[] = [
	"applied",
	"refused",
	"failed",
	"timed-out",
	"dropped",
];
const RESULT_STATUSES: ModemOperationResultStatus[] = [
	"applied",
	"refused",
	"unknown-outcome",
	"failed",
];
const UNKNOWN_REASONS: ModemOperationUnknownReason[] = [
	"stale-generation",
	"write-reply-timed-out",
	"write-reply-dropped",
];
const REFUSAL_REASONS: ModemManagerRefusalReason[] = [
	"unauthorized",
	"unsupported",
	"wrong-state",
	"busy",
	"not-found",
	"timed-out",
	"disconnected",
	"failed",
];

/** An error carrying the D-Bus name `mapModemManagerError` keys on. */
function dbusError(name: string): Error {
	const err = new Error("call refused");
	Reflect.set(err, "dbusName", `org.freedesktop.ModemManager1.Error.${name}`);
	return err;
}

const ERROR_FOR_REASON: Record<ModemManagerRefusalReason, () => unknown> = {
	unauthorized: () => dbusError("Unauthorized"),
	unsupported: () => dbusError("NotSupported"),
	"wrong-state": () => dbusError("WrongState"),
	busy: () => dbusError("InProgress"),
	"not-found": () => dbusError("UnknownModem"),
	"timed-out": () => new TransportError("method call timed out"),
	disconnected: () => new DisconnectedError(),
	failed: () => new Error("something nobody classified"),
};

describe("the 20-value vocabulary is exactly what the package emits", () => {
	test("the four enums carry exactly 5 + 4 + 3 + 8 members", () => {
		expect(modemOperationCompletionStatusSchema.options).toEqual(
			COMPLETION_STATUSES,
		);
		expect(modemOperationResultStatusSchema.options).toEqual(RESULT_STATUSES);
		expect(modemOperationUnknownReasonSchema.options).toEqual(UNKNOWN_REASONS);
		expect(modemManagerRefusalReasonSchema.options).toEqual(REFUSAL_REASONS);

		expect(
			COMPLETION_STATUSES.length +
				RESULT_STATUSES.length +
				UNKNOWN_REASONS.length +
				REFUSAL_REASONS.length,
		).toBe(20);
	});

	// The MUST-NOT of this todo made mechanical: a reason CeraUI invented would
	// pass every other test in this file and fail only here.
	test("the refusal enum is byte-identical to the package's own frozen list", () => {
		expect(modemManagerRefusalReasonSchema.options).toEqual([
			...MODEM_MANAGER_REFUSAL_REASONS,
		]);
	});

	test("the retryable table is TOTAL over the refusal enum", () => {
		expect(Object.keys(MODEM_MANAGER_REFUSAL_RETRYABLE).sort()).toEqual(
			[...REFUSAL_REASONS].sort(),
		);
	});
});

describe("every MM refusal reason survives the projection untranslated", () => {
	for (const reason of REFUSAL_REASONS) {
		test(`${reason} keeps its reason and its retryability`, () => {
			const outcome = modemOperationOutcomeFromError(
				ERROR_FOR_REASON[reason](),
			);

			expect(outcome.status).toBe("refused");
			expect(outcome.completion).toBe("failed");
			// The typed refusal AND the free-string reason agree — a consumer may
			// branch on either without the two disagreeing about the same failure.
			expect(outcome).toMatchObject({ reason, refusal: reason });
			expect(outcome).toHaveProperty(
				"retryable",
				MODEM_MANAGER_REFUSAL_RETRYABLE[reason],
			);
			expect(modemOperationOutcomeSchema.parse(outcome)).toEqual(outcome);
		});
	}

	test("retryability splits device-state refusals from authority ones", () => {
		const retryable = REFUSAL_REASONS.filter(
			(r) => MODEM_MANAGER_REFUSAL_RETRYABLE[r],
		);
		expect(retryable).toEqual([
			"wrong-state",
			"busy",
			"timed-out",
			"disconnected",
		]);
	});

	// Non-vacuity: without a real classification every arm would answer the
	// package's `failed` fallback and the loop above would still be green.
	test("the projection does not collapse every error onto `failed`", () => {
		const reasons = new Set(
			REFUSAL_REASONS.map((r) => {
				const outcome = modemOperationOutcomeFromError(ERROR_FOR_REASON[r]());
				return outcome.status === "refused" ? outcome.reason : "";
			}),
		);
		expect(reasons.size).toBe(REFUSAL_REASONS.length);
	});
});

describe("every completion status classifies, and the READ/WRITE split holds", () => {
	const cases: Array<{
		completion: ModemOperationCompletionStatus;
		operation: "read" | "write";
		status: ModemOperationResultStatus;
		reason?: string;
	}> = [
		{ completion: "applied", operation: "write", status: "applied" },
		{
			completion: "refused",
			operation: "write",
			status: "refused",
			reason: "band-certification-required",
		},
		{
			completion: "failed",
			operation: "write",
			status: "failed",
			reason: "readback-mismatch",
		},
		{
			completion: "timed-out",
			operation: "write",
			status: "unknown-outcome",
			reason: "write-reply-timed-out",
		},
		{
			completion: "dropped",
			operation: "write",
			status: "unknown-outcome",
			reason: "write-reply-dropped",
		},
		{
			completion: "timed-out",
			operation: "read",
			status: "failed",
			reason: "read-reply-timed-out",
		},
		{
			completion: "dropped",
			operation: "read",
			status: "failed",
			reason: "read-reply-dropped",
		},
	];

	for (const c of cases) {
		test(`${c.completion} on a ${c.operation} is ${c.status}`, () => {
			const completion =
				c.completion === "applied"
					? ({ status: "applied", value: undefined } as const)
					: c.completion === "refused" || c.completion === "failed"
						? ({ status: c.completion, reason: c.reason as string } as const)
						: ({ status: c.completion } as const);

			const outcome = classifyModemOperationOutcome({
				operation: c.operation,
				completion,
				completionGeneration: 7,
				currentGeneration: 7,
			});

			expect(outcome.status).toBe(c.status);
			expect(outcome.completion).toBe(c.completion);
			if (c.reason !== undefined && outcome.status !== "applied") {
				expect(outcome.reason).toBe(c.reason);
			}
			expect(modemOperationOutcomeSchema.parse(outcome)).toEqual(outcome);
		});
	}

	test("every completion status is exercised above", () => {
		expect(new Set(cases.map((c) => c.completion))).toEqual(
			new Set(COMPLETION_STATUSES),
		);
	});

	test("every result status is reachable", () => {
		const reached = new Set(cases.map((c) => c.status));
		expect(reached).toEqual(new Set(RESULT_STATUSES));
	});
});

describe("unknown-outcome is neither a success nor a failure", () => {
	test("a stale generation is unknown-outcome whatever the completion said", () => {
		const outcome = classifyModemOperationOutcome({
			operation: "write",
			completion: { status: "applied", value: undefined },
			completionGeneration: 7,
			currentGeneration: 8,
		});

		expect(outcome).toEqual({
			status: "unknown-outcome",
			completion: "applied",
			reason: "stale-generation",
			requires_reconciliation: true,
			retryable: false,
		});
	});

	for (const reason of UNKNOWN_REASONS) {
		test(`${reason} demands reconciliation and refuses a retry`, () => {
			const outcome =
				reason === "stale-generation"
					? classifyModemOperationOutcome({
							operation: "write",
							completion: { status: "applied", value: undefined },
							completionGeneration: 1,
							currentGeneration: 2,
						})
					: classifyModemOperationOutcome({
							operation: "write",
							completion: {
								status:
									reason === "write-reply-timed-out" ? "timed-out" : "dropped",
							},
							completionGeneration: 1,
							currentGeneration: 1,
						});

			expect(outcome).toMatchObject({
				status: "unknown-outcome",
				reason,
				requires_reconciliation: true,
				retryable: false,
			});
			expect(modemOperationOutcomeSchema.parse(outcome)).toEqual(outcome);
		});
	}

	test("only unknown-outcome carries requires_reconciliation", () => {
		for (const outcome of [
			modemOperationApplied(),
			modemOperationRefused("provisioning_disabled"),
			modemOperationOutcomeFromError(dbusError("Unauthorized")),
		]) {
			expect(outcome).not.toHaveProperty("requires_reconciliation");
		}
	});
});

describe("a CeraUI-authored refusal is not dressed up as a daemon one", () => {
	test("it carries the reason with NO typed refusal beside it", () => {
		const outcome = modemOperationRefused("provisioning_disabled");

		expect(outcome).toEqual({
			status: "refused",
			completion: "refused",
			reason: "provisioning_disabled",
			retryable: false,
		});
		expect(outcome).not.toHaveProperty("refusal");
	});

	// A CeraUI reason string that happened to be `failed` must not silently
	// acquire the package's fallback arm, and one that is not a member must not
	// be coerced into one.
	test("a non-member reason from the classifier publishes no refusal", () => {
		const outcome = classifyModemOperationOutcome({
			operation: "write",
			completion: { status: "refused", reason: "reconciliation-required" },
			completionGeneration: 3,
			currentGeneration: 3,
		});

		expect(outcome).toMatchObject({
			status: "refused",
			reason: "reconciliation-required",
			retryable: false,
		});
		expect(outcome).not.toHaveProperty("refusal");
	});
});

describe("the local fallback mirrors the package rather than stubbing it", () => {
	// Without this the whole suite could be green against the mirror alone, which
	// would prove nothing about the release CeraUI actually pins.
	test("the PACKAGE's own functions are what the projection runs", () => {
		expect(hasModemControlFunction("mapModemManagerError")).toBe(true);
		expect(hasModemControlFunction("classifyOperationCompletion")).toBe(true);
	});

	for (const reason of REFUSAL_REASONS) {
		test(`${reason} matches the package's own verdict`, () => {
			expect(
				__testing.mapModemManagerErrorFallback(ERROR_FOR_REASON[reason]()),
			).toEqual({
				reason,
				retryable: MODEM_MANAGER_REFUSAL_RETRYABLE[reason],
			});
		});
	}

	test("the classifier fallback reproduces the READ/WRITE split", () => {
		expect(
			__testing.classifyOperationCompletionFallback(
				{ status: "timed-out" },
				"write",
				false,
			),
		).toMatchObject({
			status: "unknown-outcome",
			reason: "write-reply-timed-out",
		});

		expect(
			__testing.classifyOperationCompletionFallback(
				{ status: "timed-out" },
				"read",
				false,
			),
		).toMatchObject({ status: "failed", reason: "read-reply-timed-out" });
	});

	test("a stale generation outranks the completion", () => {
		expect(
			__testing.classifyOperationCompletionFallback(
				{ status: "applied", value: 1 },
				"write",
				true,
			),
		).toMatchObject({ status: "unknown-outcome", reason: "stale-generation" });
	});
});

describe("the wire shape refuses a dishonest outcome", () => {
	test("an empty reason is rejected — it renders as a generic failure", () => {
		expect(
			modemOperationOutcomeSchema.safeParse({
				status: "refused",
				completion: "failed",
				reason: "",
				retryable: false,
			}).success,
		).toBe(false);
	});

	test("an applied outcome cannot claim to be retryable", () => {
		expect(
			modemOperationOutcomeSchema.safeParse({
				status: "applied",
				completion: "applied",
				retryable: true,
			}).success,
		).toBe(false);
	});

	test("unknown-outcome cannot carry a free-string reason", () => {
		expect(
			modemOperationOutcomeSchema.safeParse({
				status: "unknown-outcome",
				completion: "timed-out",
				reason: "something-else",
				requires_reconciliation: true,
				retryable: false,
			}).success,
		).toBe(false);
	});

	test("retryable is required on every arm", () => {
		expect(
			modemOperationOutcomeSchema.safeParse({
				status: "refused",
				completion: "refused",
				reason: "busy",
			}).success,
		).toBe(false);
	});
});
