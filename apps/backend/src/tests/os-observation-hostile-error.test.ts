import { expect, test } from "bun:test";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { recordedAdmissionDeps } from "./helpers/os-admission-recorded.ts";

test.each([false, true])(
	"keeps null semantics with a throwing message getter (report=%s)",
	async (reporting) => {
		// Given an exception whose formatting itself would throw.
		const error = new Error();
		Object.defineProperty(error, "message", {
			get() {
				throw new TypeError("hostile getter");
			},
		});
		const reports: string[] = [];
		// When the real observer catches it, with or without a diagnostic sink.
		const result = await observeRaucStage(
			{ processes: new Set(), resources: new Set() },
			{
				...recordedAdmissionDeps,
				healthy: async () => {
					throw error;
				},
			},
			reporting ? (detail) => reports.push(detail) : undefined,
		);
		// Then formatting never replaces the observation refusal.
		expect(result).toBeNull();
		if (reporting) expect(reports).toHaveLength(1);
	},
);

test("omits arbitrary exception messages rather than attempting secret redaction", async () => {
	// Given a message the previous sanitizer and logger both leaked.
	const error = new Error("password: SAMPLE_PASSWORD_CREDENTIAL");
	const reports: string[] = [];
	// When the observer reports the failed boundary.
	const result = await observeRaucStage(
		{ processes: new Set(), resources: new Set() },
		{
			...recordedAdmissionDeps,
			healthy: async () => {
				throw error;
			},
		},
		(detail) => reports.push(detail),
	);
	// Then no message bytes reach the diagnostic channel.
	expect(result).toBeNull();
	expect(reports).toEqual(["healthy-state: Error:"]);
});

test.each(["name", "code"])(
	"uses a safe fallback when the %s getter throws",
	async (field) => {
		// Given diagnostic properties are arbitrary objects too.
		const error = new Error();
		Object.defineProperty(error, field, {
			get() {
				throw new TypeError("getter");
			},
		});
		const reports: string[] = [];
		// When the failed observation formats the diagnostic.
		const result = await observeRaucStage(
			{ processes: new Set(), resources: new Set() },
			{
				...recordedAdmissionDeps,
				healthy: async () => {
					throw error;
				},
			},
			(detail) => reports.push(detail),
		);
		// Then the diagnostic is bounded and the safety result survives.
		expect(result).toBeNull();
		expect(reports).toEqual(["healthy-state: unknown-error"]);
	},
);

test("reads the error class once before allowlisting a hostile getter", async () => {
	// Given successive getter values would bypass a check-then-read allowlist.
	const error = new Error();
	let reads = 0;
	Object.defineProperty(error, "name", {
		get: () =>
			reads++ === 0 ? "Error" : "password: SAMPLE_PASSWORD_CREDENTIAL",
	});
	const reports: string[] = [];
	// When the observer formats the caught failure.
	const result = await observeRaucStage(
		{ processes: new Set(), resources: new Set() },
		{
			...recordedAdmissionDeps,
			healthy: async () => {
				throw error;
			},
		},
		(detail) => reports.push(detail),
	);
	// Then only the single observed and allowlisted class reaches the sink.
	expect(result).toBeNull();
	expect(reports).toEqual(["healthy-state: Error:"]);
});
