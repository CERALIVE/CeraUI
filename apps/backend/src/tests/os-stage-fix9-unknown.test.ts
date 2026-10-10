import { expect, test } from "bun:test";
import { observeAdmission } from "../modules/system/update-orchestrator/os-stage-admission-snapshot.ts";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { censusDriftFixture } from "./helpers/os-stage-census-drift-fixture.ts";
import {
	nonCensusFaults,
	unknownEvidenceFixture,
} from "./helpers/os-stage-fix10-unknown-fixture.ts";
import { rockHelperFixture } from "./helpers/os-stage-rock-helper-fixture.ts";

for (const drift of [
	"retiring-process",
	"appearing-process",
	"resource",
] as const) {
	test.each([...nonCensusFaults])(
		`%s stays terminal when censuses have ${drift}`,
		async (fault) => {
			// Given independent invalid evidence in a drifted pair, then clean responses.
			const census = censusDriftFixture(drift);
			const fixture = unknownEvidenceFixture(census.deps, fault);
			let sleeps = 0;
			let replacements = 0;
			// When the real observer/admission seam sees the combined fault.
			const work = observeAdmission(
				(report) =>
					observeRaucStage(
						{ processes: new Set(), resources: new Set() },
						fixture.deps,
						report,
					),
				undefined,
				{
					now: () => 0,
					deadline: 300,
					sleep: async () => {
						sleeps++;
					},
					assert: async () => undefined,
				},
			).then((proof) => {
				replacements++;
				return proof;
			});
			await expect(work).rejects.toHaveProperty("mode", "unsafe");
			// Then invalid non-census evidence grants neither pacing nor replacement.
			expect(sleeps).toBe(0);
			expect(replacements).toBe(0);
			expect(fixture.operations()).toBe(1);
		},
	);
}

test.each([
	"command",
	"timeout",
	"malformed",
	"duplicate",
	"ActiveState",
	"MainPID",
	"ControlGroup",
	"InvocationID",
] as const)(
	"final unit %s failure stays terminal unknown rather than retrying",
	async (fault) => {
		// Given a clean first census and a genuine final-service failure, then clean responses.
		const fixture = rockHelperFixture([]);
		let shows = 0;
		let sleeps = 0;
		const deps = {
			...fixture.deps,
			run: async (...args: Parameters<typeof fixture.deps.run>) => {
				const result = await fixture.deps.run(...args);
				if (args[0][0] !== "systemctl" || ++shows !== 2) return result;
				switch (fault) {
					case "command":
						return { ...result, exitCode: 1 };
					case "timeout":
						throw Object.assign(new Error("fixture timeout"), {
							name: "SpawnTimeoutError",
						});
					case "malformed":
						return { ...result, stdout: "invalid" };
					case "duplicate":
						return { ...result, stdout: `${result.stdout}MainPID=729106\n` };
					case "ActiveState":
						return {
							...result,
							stdout: result.stdout.replace("active", "inactive"),
						};
					case "MainPID":
						return {
							...result,
							stdout: result.stdout.replace("729106", "729107"),
						};
					case "ControlGroup":
						return {
							...result,
							stdout: result.stdout.replace("rauc.service", "other.service"),
						};
					case "InvocationID":
						return {
							...result,
							stdout: `${result.stdout}InvocationID=${"a".repeat(32)}\n`,
						};
					default:
						throw new Error(fault satisfies never);
				}
			},
		};
		// When admission observes that final failure inside its proof budget.
		await expect(
			observeAdmission(
				(report) =>
					observeRaucStage(
						{ processes: new Set(), resources: new Set() },
						deps,
						report,
					),
				undefined,
				{
					now: () => 0,
					deadline: 300,
					sleep: async () => {
						sleeps++;
					},
					assert: async () => undefined,
				},
			),
		).rejects.toHaveProperty("diagnostics.predicate", "observation-unknown");
		// Then even a later clean response cannot turn genuine unknown into permission.
		expect(sleeps).toBe(0);
		expect(shows).toBe(2);
	},
);

test("final proof read reports its own drift and cannot reuse prior observation detail", async () => {
	// Given a clean preliminary sample but drift in the post-ownership final read.
	const clean = rockHelperFixture([]);
	const drift = censusDriftFixture("retiring-process");
	let reads = 0;
	let now = 0;
	// When admission's awaited quiescence requires a fresh final observation.
	const proof = await observeAdmission(
		(report) =>
			observeRaucStage(
				{ processes: new Set(), resources: new Set() },
				++reads === 2 ? drift.deps : clean.deps,
				report,
			),
		undefined,
		{
			now: () => now,
			deadline: 300,
			sleep: async (ms) => {
				now += ms;
			},
			assert: async () => undefined,
			quiescence: async () => null,
			finalQuiescence: () => null,
		},
	);
	// Then the drifted final read is retried and only a subsequent clean pair returns.
	expect(proof.resources).toEqual([]);
	expect(reads).toBe(4);
	expect(now).toBe(100);
});

test("an unknown final read after drift stays terminal without stale drift permission", async () => {
	// Given one drifted preliminary read, then clean preparation, then an unknown final read.
	const drift = censusDriftFixture("retiring-process");
	let reads = 0;
	let now = 0;
	// When final observation returns null without the closed drift diagnostic.
	await expect(
		observeAdmission(
			(report) =>
				++reads === 3
					? Promise.resolve(null)
					: observeRaucStage(
							{ processes: new Set(), resources: new Set() },
							drift.deps,
							report,
						),
			undefined,
			{
				now: () => now,
				deadline: 300,
				sleep: async (ms) => {
					now += ms;
				},
				assert: async () => undefined,
				quiescence: async () => null,
				finalQuiescence: () => null,
			},
		),
	).rejects.toHaveProperty("diagnostics.predicate", "observation-unknown");
	// Then prior drift cannot authorize another retry of this genuine unknown.
	expect(reads).toBe(3);
	expect(now).toBe(100);
});
