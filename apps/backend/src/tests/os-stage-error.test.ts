import { describe, expect, test } from "bun:test";
import { OsAgentError } from "../modules/system/update-orchestrator/os-identity.ts";
import {
	isOsStageError,
	OS_STAGE_FAILURE_MODE,
	OS_STAGE_FAILURE_REASONS,
	OsStageError,
	type OsStageFailureReason,
	type OsStageRecoveryMode,
} from "../modules/system/update-orchestrator/os-stage-error.ts";

const RECOVERY_MODES = [
	"automatic",
	"operator",
	"unsafe",
	"cancelled",
] as const;

const EXPECTED_MODES: Readonly<
	Record<OsStageFailureReason, OsStageRecoveryMode>
> = {
	os_transport_failed: "automatic",
	os_origin_unavailable: "automatic",
	os_update_lock_held: "automatic",
	os_cellular_approval_required: "operator",
	os_stage_cancelled_for_stream: "cancelled",
	rauc_install_failed: "operator",
	rauc_recovery_unproven: "unsafe",
	os_stage_outcome_unknown_after_restart: "unsafe",
};

describe("the OS stage failure contract", () => {
	test("the mode table covers every reason exactly once, with expected values", () => {
		expect(Object.keys(OS_STAGE_FAILURE_MODE).sort()).toEqual(
			[...OS_STAGE_FAILURE_REASONS].sort(),
		);
		for (const reason of OS_STAGE_FAILURE_REASONS) {
			expect(OS_STAGE_FAILURE_MODE[reason]).toBe(EXPECTED_MODES[reason]);
			expect(RECOVERY_MODES).toContain(OS_STAGE_FAILURE_MODE[reason]);
		}
	});

	test("derives the recovery mode from the reason", () => {
		expect(new OsStageError("os_transport_failed").mode).toBe("automatic");
		for (const reason of OS_STAGE_FAILURE_REASONS) {
			expect(new OsStageError(reason).mode).toBe(OS_STAGE_FAILURE_MODE[reason]);
		}
	});

	test("carries the reason as the message and identifies itself", () => {
		const error = new OsStageError("rauc_recovery_unproven");
		expect(error.message).toBe("rauc_recovery_unproven");
		expect(error.reason).toBe("rauc_recovery_unproven");
		expect(error.name).toBe("OsStageError");
	});

	test("forwards cause and diagnostics, defaulting diagnostics to empty", () => {
		const cause = new Error("boom");
		const diagnostics = { exitCode: 1, stage: "download" as const };
		const error = new OsStageError("rauc_install_failed", {
			cause,
			diagnostics,
		});
		expect(error.cause).toBe(cause);
		expect(error.diagnostics).toEqual(diagnostics);
		expect(new OsStageError("os_origin_unavailable").diagnostics).toEqual({});
	});

	test("recognizes only its own class", () => {
		expect(isOsStageError(new OsStageError("os_update_lock_held"))).toBe(true);
		expect(isOsStageError(new Error("x"))).toBe(false);
		expect(isOsStageError(new OsAgentError("boot_id_unknown"))).toBe(false);
	});
});
