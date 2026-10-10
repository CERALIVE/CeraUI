import { expect, test } from "bun:test";
import { observeAdmission } from "../modules/system/update-orchestrator/os-stage-admission-snapshot.ts";
import { rememberStageEvidence } from "../modules/system/update-orchestrator/os-stage-process-evidence.ts";
import type { RaucStageSnapshot } from "../modules/system/update-orchestrator/os-stage-recovery.ts";
import { baseline } from "./helpers/os-stage-run-inputs.ts";

const extra = { ...baseline, processes: [baseline.instance, "877184:2852694"] };

function clock(start = 0, deadline = 10_000) {
	let now = start;
	let sleeps = 0;
	return {
		now: () => now,
		sleep: async (ms: number) => {
			now += ms;
			sleeps++;
		},
		assert: async () => {},
		deadline,
		advance: (ms: number) => {
			now += ms;
		},
		sleeps: () => sleeps,
	};
}

test("admission keeps re-observing until a fresh strict proof when an extra member exits", async () => {
	// Given the same snapshot is not clean until the third fresh read.
	const wait = clock();
	let observations = 0;
	// When bounded admission sees two extra-member snapshots before clean.
	const result = await observeAdmission(
		async () => (++observations < 3 ? extra : baseline),
		baseline,
		wait,
	);
	// Then the returned object is the final clean observation, not a projection.
	expect(result).toBe(baseline);
	expect(observations).toBe(3);
});

test.each([
	"old exact PID",
	"escaped tracked writer",
	"unknown foreign PID",
	"reused cgroup PID",
])(
	"admission stays unsafe for a persistent %s until the original shared deadline",
	async (_condition) => {
		// Given 313 seconds were already spent retiring the failed pair.
		const wait = clock(313_000, 360_000);
		// When an extra member never disappears from the fresh evidence.
		await expect(
			observeAdmission(async () => extra, baseline, wait),
		).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
		// Then no fresh six-minute window was allocated at this boundary.
		expect(wait.now()).toBe(360_000);
	},
);

test.each([
	["boot", { bootId: "changed" }],
	["target", { targetDevice: "different" }],
	["primary", { bootPrimary: baseline.targetSlot }],
	["activation", { activationArmed: true }],
	["resource", { resources: ["dm:253:7:residue"] }],
] satisfies readonly (readonly [string, Partial<RaucStageSnapshot>])[])(
	"admission immediately refuses changed %s even when extras mask it",
	async (_condition, patch) => {
		// Given both a transient-looking member and structural unsafe evidence.
		const wait = clock();
		// When admission evaluates the complete snapshot.
		await expect(
			observeAdmission(async () => ({ ...extra, ...patch }), baseline, wait),
		).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
		// Then structural uncertainty is never deferred.
		expect(wait.sleeps()).toBe(0);
	},
);

test.each(["MainPID", "InvocationID"])(
	"a changed %s during deferral cannot become fresh admission",
	async (field) => {
		// Given two snapshots with different service identities across the wait.
		const wait = clock();
		const first = { ...extra };
		const final =
			field === "MainPID"
				? { ...baseline, instance: "new:3", processes: ["new:3"] }
				: { ...baseline };
		rememberStageEvidence(first, {
			started: 0,
			finished: 1,
			mainPid: "659",
			invocationId: "a".repeat(32),
			members: [],
		});
		rememberStageEvidence(final, {
			started: 2,
			finished: 3,
			mainPid: field === "MainPID" ? "new" : "659",
			invocationId: "b".repeat(32),
			members: [],
		});
		let reads = 0;
		// When the final member census is clean but the service changed.
		await expect(
			observeAdmission(
				async () => (++reads === 1 ? first : final),
				baseline,
				wait,
			),
		).rejects.toMatchObject({
			diagnostics: { predicate: "daemon-identity-changed" },
		});
		// Then no third observation is used to excuse the identity transition.
		expect(reads).toBe(2);
	},
);

test("an absent observation is never upgraded to identity proof during helper deferral", async () => {
	// Given a helper followed by an unreadable/disappearing service observation.
	const wait = clock();
	let reads = 0;
	// When the second observation cannot establish identity.
	await expect(
		observeAdmission(
			async () => (++reads === 1 ? extra : null),
			baseline,
			wait,
		),
	).rejects.toMatchObject({
		diagnostics: { predicate: "observation-unknown" },
	});
	// Then unknown stays unsafe instead of reusing the first observation.
	expect(reads).toBe(2);
});

test.each(["observer", "authority"])(
	"admission checks the final clock after slow %s work",
	async (slow) => {
		// Given clean evidence completes at, not before, the deadline.
		const wait = clock();
		let assertions = 0;
		// When observation or its post-read authority check consumes the budget.
		await expect(
			observeAdmission(
				async () => {
					if (slow === "observer") wait.advance(10_000);
					return baseline;
				},
				baseline,
				{
					...wait,
					assert: async () => {
						if (++assertions === 2 && slow === "authority")
							wait.advance(10_000);
					},
				},
			),
		).rejects.toMatchObject({ diagnostics: { predicate: "deadline-expired" } });
		// Then the clean snapshot cannot authorize action after expiry.
		expect(wait.now()).toBe(10_000);
	},
);
