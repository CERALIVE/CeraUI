import { afterEach, expect, test } from "bun:test";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { baseline, manifest } from "./helpers/os-stage-run-inputs.ts";

afterEach(cleanupRecovery);

test("retry-admission helpers use only the remainder of the failed pair's 360s budget", async () => {
	// Given restart submission and physical retirement have consumed 313 seconds.
	const h = await harness();
	let now = 0;
	let extra = false;
	// When a persistent foreign member appears after the recovery proof.
	await expect(
		runOsStageJob(manifest, h.control, {
			...h.deps,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
			restart: async () => {
				now += 313_000;
				await h.deps.restart();
			},
			selection: async () => {
				const result = await h.deps.selection();
				extra = h.attempts() === 1;
				return result;
			},
			observe: async (...args) => {
				const snapshot = await h.deps.observe(...args);
				return extra && snapshot
					? { ...snapshot, processes: [...snapshot.processes, "foreign:7"] }
					: snapshot;
			},
		}),
	).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
	// Then no second writer or release occurs and the original deadline is final.
	expect(now).toBe(360_000);
	expect(h.attempts()).toBe(1);
	expect(h.events).not.toContain("release");
});

test.each([
	"cancellation",
	"GoLive",
	"CONTROL",
	"guardian",
	"private record",
	"candidate expiry",
	"transport expiry",
])(
	"no next writer launches when %s invalidates authority during the helper wait",
	async (fault) => {
		// Given a recovered first pair and helper churn at the next admission boundary.
		const h = await harness();
		let waiting = false;
		let retired = false;
		let invalid = false;
		let retainedOwner: ReturnType<typeof h.deps.owner> | undefined;
		// When the wait finishes but one dispatch prerequisite has changed.
		await expect(
			runOsStageJob(manifest, h.control, {
				...h.deps,
				owner: (record) => {
					const owner = h.deps.owner(record);
					retainedOwner = owner;
					return {
						...owner,
						assertAuthority: async () => {
							if (fault === "private record" && invalid)
								throw new OsStageError("rauc_recovery_unproven");
						},
						held: async () =>
							fault === "guardian" && invalid ? false : owner.held(),
					};
				},
				blocked: async () => fault === "GoLive" && invalid,
				acquireControl: async () => {
					const lease = await h.deps.acquireControl?.();
					if (!lease) throw new Error("fixture control missing");
					return {
						...lease,
						held: () => (fault === "CONTROL" && invalid ? false : lease.held()),
						[Symbol.asyncDispose]: () => lease[Symbol.asyncDispose](),
					};
				},
				selection: async () => {
					const selected = await h.deps.selection();
					waiting = h.attempts() === 1;
					return fault === "transport expiry" && invalid
						? { ...selected, ranked: [] }
						: selected;
				},
				observe: async (...args) => {
					const snapshot = await h.deps.observe(...args);
					return waiting && !retired && snapshot
						? { ...snapshot, processes: [...snapshot.processes, "helper:9"] }
						: snapshot;
				},
				revalidate: async () => {
					if (fault === "candidate expiry" && invalid)
						throw new OsStageError("rauc_install_failed", {
							diagnostics: { refusal: "expired" },
						});
					await h.deps.revalidate();
				},
				sleep: async (ms) => {
					const retained = retainedOwner?.record();
					expect(retained).toMatchObject({
						launched: true,
						cliSettled: true,
						requireNewInstance: true,
						baseline: { instance: baseline.instance },
					});
					expect(retained?.processes).toContain(baseline.instance);
					retired = true;
					invalid = true;
					if (fault === "cancellation") h.signal.abort();
					await h.deps.sleep(ms);
				},
			}),
		).rejects.toBeInstanceOf(OsStageError);
		// Then the previous launched ownership is retained through the wait and no new install begins.
		expect(h.attempts()).toBe(1);
		expect(h.events).not.toContain("receipt+serial+OS_STAGED");
	},
);

test("successful-but-unpublished install stays unsafe without restaging when final helpers persist", async () => {
	// Given the replacement CLI succeeded and only publication proof remains.
	const h = await harness();
	let publishing = false;
	// When a helper never retires before the final settlement deadline.
	await expect(
		runOsStageJob(manifest, h.control, {
			...h.deps,
			prepareReceipt: async () => {
				publishing = true;
				return h.deps.prepareReceipt();
			},
			observe: async (...args) => {
				const snapshot = await h.deps.observe(...args);
				return publishing && snapshot
					? { ...snapshot, processes: [...snapshot.processes, "helper:9"] }
					: snapshot;
			},
		}),
	).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
	// Then no receipt, lock release or third install is manufactured.
	expect(h.attempts()).toBe(2);
	expect(h.events).not.toContain("receipt+serial+OS_STAGED");
	expect(h.events).not.toContain("release");
});

test("successful final settlement waits for helper exit and publishes exactly once", async () => {
	// Given completed CLI success followed by a helper in the publication census.
	const h = await harness();
	let publishing = false;
	let retired = false;
	// When a fresh later census proves release without returning to install.
	const receipt = await runOsStageJob(manifest, h.control, {
		...h.deps,
		prepareReceipt: async () => {
			publishing = true;
			return h.deps.prepareReceipt();
		},
		observe: async (...args) => {
			const snapshot = await h.deps.observe(...args);
			return publishing && !retired && snapshot
				? { ...snapshot, processes: [...snapshot.processes, "helper:9"] }
				: snapshot;
		},
		sleep: async (ms) => {
			retired = true;
			await h.deps.sleep(ms);
		},
	});
	// Then the successful pair is neither retried nor silently left unpublished.
	expect(receipt).toBe("receipt");
	expect(h.attempts()).toBe(2);
	expect(
		h.events.filter((event) => event === "receipt+serial+OS_STAGED"),
	).toHaveLength(1);
});
