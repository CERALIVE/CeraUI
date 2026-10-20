import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import { requireAdmissionSnapshot } from "../modules/system/update-orchestrator/os-stage-admission-snapshot.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import type { RaucStageSnapshot } from "../modules/system/update-orchestrator/os-stage-recovery.ts";
import { recordedAdmissionDeps } from "./helpers/os-admission-recorded.ts";

const observed = await observeRaucStage(
	{ processes: new Set(), resources: new Set() },
	recordedAdmissionDeps,
);
if (!observed)
	throw new Error("complete recorded Rock input must be observable");
const baseline = observed;
const warn = spyOn(logger, "warn").mockImplementation(() => logger);
afterEach(() => warn.mockClear());
afterAll(() => warn.mockRestore());

function refusal(
	snapshot: RaucStageSnapshot | null,
	previous?: RaucStageSnapshot,
): unknown {
	try {
		requireAdmissionSnapshot(snapshot, previous);
	} catch (error) {
		return error;
	}
	return undefined;
}

const cases: readonly (readonly [string, Partial<RaucStageSnapshot> | null])[] =
	[
		["observation-unknown", null],
		["daemon-inactive", { active: false }],
		["operation-not-idle", { operation: null }],
		["resources-present", { resources: ["mount:23:1:/run/rauc"] }],
		["extra-process", { processes: [baseline.instance, "651:986"] }],
		["booted-unhealthy", { bootedHealthy: false }],
		["target-not-inactive", { targetInactive: false }],
		["boot-primary-unknown", { bootPrimary: null }],
		["boot-primary-not-booted", { bootPrimary: baseline.targetSlot }],
		["boot-primary-is-target", { targetSlot: baseline.bootPrimary ?? "" }],
		["activation-armed", { activationArmed: true }],
	];

test.each(cases)(
	"names %s without changing unsafe admission",
	(predicate, change) => {
		// Given one failing predicate against the later complete Rock observation.
		const current = change === null ? null : { ...baseline, ...change };
		// When production admission refuses.
		const error = refusal(current);
		// Then the stable classification survives and the predicate is named once.
		expect(error).toBeInstanceOf(OsStageError);
		expect(error).toMatchObject({
			reason: "rauc_recovery_unproven",
			mode: "unsafe",
			diagnostics: { refusal: "stage-admission-unproven", predicate },
		});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"update-orchestrator: OS stage admission refused",
			expect.objectContaining({ predicate }),
		);
	},
);

test.each([
	"bootId",
	"bootPrimary",
	"bootedSlot",
	"bootedDevice",
	"targetSlot",
	"targetDevice",
] as const)("names a changed baseline %s", (field) => {
	// Given an otherwise admitted observation and a distinct earlier identity.
	const previous = { ...baseline, [field]: "different-recorded-identity" };
	// When the later observation is compared with that baseline.
	const error = refusal(baseline, previous);
	// Then the exact changed field is diagnosed.
	expect(error).toMatchObject({
		reason: "rauc_recovery_unproven",
		diagnostics: {
			refusal: "stage-admission-unproven",
			predicate: `baseline-changed:${field}`,
		},
	});
});

test("admits the complete later Rock capture without claiming refusal-time truth", () => {
	// Given all reached reads captured twelve minutes or more after the refusal.
	// When the unchanged admission requirements are evaluated.
	const admitted = requireAdmissionSnapshot(baseline, baseline);
	// Then this later capture is admitted and nothing is logged.
	expect(admitted).toBe(baseline);
	expect(warn).not.toHaveBeenCalled();
});

// The admission condition exactly as shipped at f857a954, kept as an
// independent oracle so a diagnostic refactor cannot move the admitted set.
function shippedRefuses(
	s: RaucStageSnapshot | null,
	b?: RaucStageSnapshot,
): boolean {
	return (
		!s?.active ||
		s.operation !== "idle" ||
		s.resources.length > 0 ||
		s.processes.some((id) => id !== s.instance) ||
		!s.bootedHealthy ||
		!s.targetInactive ||
		!s.bootPrimary ||
		s.bootPrimary !== s.bootedSlot ||
		s.bootPrimary === s.targetSlot ||
		s.activationArmed ||
		(b !== undefined &&
			(s.bootId !== b.bootId ||
				s.bootPrimary !== b.bootPrimary ||
				s.bootedSlot !== b.bootedSlot ||
				s.bootedDevice !== b.bootedDevice ||
				s.targetSlot !== b.targetSlot ||
				s.targetDevice !== b.targetDevice))
	);
}

test("refuses exactly the snapshots the shipped condition refused", () => {
	// Given every combination of eleven independent admission faults.
	const toggles: readonly Partial<RaucStageSnapshot>[] = [
		{ active: false },
		{ operation: "installing" },
		{ resources: ["mount:1:1:/run/rauc"] },
		{ processes: [baseline.instance, "9:9"] },
		{ bootedHealthy: false },
		{ targetInactive: false },
		{ bootPrimary: null },
		{ bootPrimary: baseline.targetSlot },
		{ targetSlot: baseline.bootedSlot },
		{ activationArmed: true },
		{ targetDevice: "999" },
	];
	let refusals = 0;
	for (let mask = 0; mask < 1 << toggles.length; mask++) {
		const current: RaucStageSnapshot = Object.assign(
			{},
			baseline,
			...toggles.filter((_, bit) => mask & (1 << bit)),
		);
		// When both conditions judge it against the recorded baseline.
		const refused = refusal(current, baseline) !== undefined;
		// Then admission is unchanged for every combination.
		expect(refused).toBe(shippedRefuses(current, baseline));
		if (refused) refusals++;
	}
	expect(refusals).toBe((1 << toggles.length) - 1);
});

test("a throwing logger cannot replace the typed refusal", () => {
	// Given a logger whose transport throws.
	warn.mockImplementation(() => {
		throw new Error("transport down");
	});
	// When admission refuses.
	let error: unknown;
	try {
		error = refusal({ ...baseline, active: false });
	} finally {
		warn.mockImplementation(() => logger);
	}
	// Then the caller still receives the unsafe admission error.
	expect(error).toMatchObject({
		reason: "rauc_recovery_unproven",
		diagnostics: { predicate: "daemon-inactive" },
	});
});

test("an unsafe wrapper keeps the admission diagnostics of its cause", () => {
	// Given a lower admission error with diagnostic provenance.
	const cause = refusal({ ...baseline, processes: [baseline.instance, "7:7"] });
	// When the runner re-classifies it without context of its own.
	const wrapped = new OsStageError("rauc_recovery_unproven", { cause });
	// Then callers still see which predicate refused, and own context wins.
	expect(wrapped.diagnostics).toEqual({
		refusal: "stage-admission-unproven",
		predicate: "extra-process",
	});
	expect(
		new OsStageError("rauc_recovery_unproven", {
			cause,
			diagnostics: { refusal: "own" },
		}).diagnostics,
	).toEqual({ refusal: "own" });
});
