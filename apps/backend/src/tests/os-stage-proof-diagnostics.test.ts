import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import { observeAdmission } from "../modules/system/update-orchestrator/os-stage-admission-snapshot.ts";
import {
	processEvidence,
	rememberStageEvidence,
} from "../modules/system/update-orchestrator/os-stage-process-evidence.ts";
import { baseline } from "./helpers/os-stage-run-inputs.ts";

afterEach(() => {
	warn.mockRestore();
});
let warn = spyOn(logger, "warn").mockImplementation(() => logger);

test("a deferral episode logs once before its final refusal and never logs arbitrary cmdline", async () => {
	// Given many identical extra-member observations with credential-bearing argv.
	warn = spyOn(logger, "warn").mockImplementation(() => logger);
	const extra = {
		...baseline,
		processes: [baseline.instance, "877184:2852694"],
	};
	rememberStageEvidence(extra, {
		started: 1,
		finished: 2,
		invocationId: "a".repeat(32),
		mainPid: "659",
		members: [
			processEvidence({
				identity: "877184:2852694",
				raw: "877184 (bash) S 659",
				listed: true,
				status: "Tgid:\t877184\n",
				cmdline:
					"bash\0/usr/bin/ceralive-boot-state\0get-primary\0secret-token\0",
			}),
		],
	});
	let now = 0;
	// When persistent extras consume a bounded 300ms episode.
	await expect(
		observeAdmission(async () => extra, baseline, {
			now: () => now,
			deadline: 300,
			sleep: async (ms) => {
				now += ms;
			},
			assert: async () => undefined,
		}),
	).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
	// Then both decisions carry bounded evidence, not arbitrary argument strings.
	expect(warn).toHaveBeenCalledTimes(2);
	expect(warn).toHaveBeenNthCalledWith(
		1,
		"update-orchestrator: OS stage proof decision",
		expect.objectContaining({
			disposition: "defer",
			started: 1,
			finished: 2,
			extraMembers: [
				expect.objectContaining({
					identity: "877184:2852694",
					operation: null,
					membership: "cgroup",
				}),
			],
		}),
	);
	expect(warn).toHaveBeenNthCalledWith(
		2,
		"update-orchestrator: OS stage proof decision",
		expect.objectContaining({ disposition: "final", deadlineRemainingMs: 0 }),
	);
});

test("throwing diagnostic sinks cannot turn a helper deferral into refusal or admission", async () => {
	// Given diagnostics throw while the observer first sees an extra member.
	warn = spyOn(logger, "warn").mockImplementation(() => {
		throw new Error("sink failed");
	});
	let now = 0;
	let reads = 0;
	// When the final observation, not the diagnostic sink, supplies clean proof.
	const result = await observeAdmission(
		async () =>
			++reads === 1
				? { ...baseline, processes: [...baseline.processes, "helper:9"] }
				: baseline,
		baseline,
		{
			now: () => now,
			deadline: 300,
			sleep: async (ms) => {
				now += ms;
			},
			assert: async () => undefined,
		},
	);
	// Then the fresh clean object is admitted with no logging-dependent decision.
	expect(result).toBe(baseline);
	expect(reads).toBe(2);
});

test.each(["observation", "quiescence"] as const)(
	"a rejected %s promise logs final bounded evidence without changing the thrown object",
	async (boundary) => {
		// Given a boundary rejection whose exception getter and message are hostile.
		warn = spyOn(logger, "warn").mockImplementation(() => logger);
		const failure = new Error("credential-bearing message must not escape");
		Object.defineProperty(failure, "name", {
			get: () => {
				throw new Error("hostile getter");
			},
		});
		// When either observer I/O or later ownership evaluation rejects.
		await expect(
			observeAdmission(
				async () => {
					if (boundary === "observation") throw failure;
					return baseline;
				},
				baseline,
				{
					now: () => 0,
					deadline: 10_000,
					sleep: async () => undefined,
					assert: async () => undefined,
					quiescence: async () => {
						if (boundary === "quiescence") throw failure;
						return null;
					},
				},
			),
		).rejects.toBe(failure);
		// Then diagnostics do not swallow the failure or manufacture an absent identity.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"update-orchestrator: OS stage proof decision",
			expect.objectContaining({
				disposition: "final",
				reason: `${boundary}-thrown`,
				observation: `${boundary}: unknown-error`,
				currentInstance: boundary === "observation" ? null : baseline.instance,
			}),
		);
	},
);
