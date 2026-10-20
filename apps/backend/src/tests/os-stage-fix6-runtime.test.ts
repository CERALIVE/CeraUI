import { afterEach, expect, test } from "bun:test";
import { spawnWithTimeout } from "../helpers/spawn-policy.ts";
import {
	setOsStageEntryDepsForTest,
	stageOsBundle,
} from "../modules/system/update-orchestrator/os-agent.ts";
import { beginOsStageAttempt } from "../modules/system/update-orchestrator/os-stage-attempt.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import {
	admitAndPrepareStreamStart,
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	fakeDeps,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";
import { settings, trustedEntry } from "./helpers/os-stage-fix6-trust.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

const foreignChildren: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOsStageEntryDepsForTest(null);
	for (const child of foreignChildren.splice(0)) {
		child.kill();
		await child.exited;
	}
});

test.each([
	"publication",
	"late-zero",
	"open-output",
	"post-sample-member",
	"post-sample-mount",
	"post-sample-target",
	"pending-proof",
])("runtime fences the real stage chain at %s", async (boundary) => {
	// Given the real runtime -> stage entry -> runner -> attempt -> subprocess chain.
	const h = await harness();
	let dispatches = 0;
	let lastAwaitedPort = "none";
	let jobs = 0;
	const postSample = boundary.startsWith("post-sample");
	let revalidations = 0;
	let sampled = false;
	let invalidated = false;
	let budgetOffset = 0;
	let restarted = false;
	let remembers = 0;
	const pendingRead =
		Promise.withResolvers<Awaited<ReturnType<typeof h.deps.observe>>>();
	const foreign =
		boundary === "post-sample-member"
			? Bun.spawn(["bash", "-c", "sleep 60"], {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				})
			: null;
	if (foreign) foreignChildren.push(foreign);
	const stat = foreign
		? await Bun.file(`/proc/${foreign.pid}/stat`).text()
		: "";
	const foreignIdentity = foreign
		? `${foreign.pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`
		: "foreign:9";
	const reached = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	setOsStageEntryDepsForTest({
		...trustedEntry,
		runJob: async (offer, control) => {
			jobs++;
			await runOsStageJob(offer, control, {
				...h.deps,
				owner: (record) => {
					const owner = h.deps.owner(record);
					return {
						...owner,
						held: async () => {
							const held = await owner.held();
							lastAwaitedPort = "guardian";
							return held;
						},
						assertAuthority: async () => {
							lastAwaitedPort = "authority";
						},
						remember: (...args) => {
							remembers++;
							owner.remember(...args);
						},
					};
				},
				...(boundary === "pending-proof"
					? {
							now: () => performance.now() + budgetOffset,
							restart: async () => {
								budgetOffset = 359_960;
								restarted = true;
								await h.deps.restart();
							},
						}
					: {}),
				revalidate: async () => {
					revalidations++;
				},
				observe: async (...args) => {
					if (boundary === "pending-proof" && restarted)
						return pendingRead.promise;
					const current = await h.deps.observe(...args);
					lastAwaitedPort = "observe";
					if (revalidations === 2) sampled = true;
					return current;
				},
				blocked: async () => {
					if (postSample && sampled && !invalidated) {
						invalidated = true;
						const current = await h.deps.observe({
							processes: new Set(),
							resources: new Set(),
						});
						if (current)
							h.setSnapshot({
								...current,
								processes: boundary.endsWith("member")
									? [...current.processes, foreignIdentity]
									: current.processes,
								resources: boundary.endsWith("mount") ? ["mount:foreign"] : [],
								targetDevice: boundary.endsWith("target")
									? "foreign-target"
									: current.targetDevice,
							});
					}
					lastAwaitedPort = "admission";
					return false;
				},
				attempt: (input) =>
					beginOsStageAttempt(input, {
						run: async (_argv, opts) => {
							dispatches++;
							expect(lastAwaitedPort).toBe("observe");
							if (postSample && dispatches > 1)
								throw new OsStageError("rauc_recovery_unproven");
							const result = await spawnWithTimeout(
								postSample || boundary === "pending-proof"
									? ["false"]
									: boundary === "open-output"
										? ["bash", "-c", "sleep 0.2 & exit 0"]
										: ["true"],
								{
									...opts,
									onExit: (code) => {
										opts?.onExit?.(code);
										if (boundary === "open-output") reached.resolve();
									},
								},
							);
							if (
								!postSample &&
								boundary !== "publication" &&
								boundary !== "pending-proof"
							) {
								reached.resolve();
								await resume.promise;
							}
							return result;
						},
						topology: async () =>
							postSample
								? { kind: "lost", reason: "admin-down" }
								: { kind: "unknown" },
						https: async () => ({ kind: "unavailable" }),
						every: (_ms, action) => {
							if (postSample) queueMicrotask(action);
							return () => {};
						},
					}),
				prepareReceipt: async () => {
					reached.resolve();
					await resume.promise;
					return h.deps.prepareReceipt();
				},
			});
			throw new Error("cancelled producer unexpectedly published");
		},
	});
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			loadSettings: async () => settings,
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming"],
			}),
			quarantine: testQuarantine(),
			checkOsManifest: async () => ({
				available: true,
				rateLimited: false,
				failed: false,
				reason: "",
				manifest,
			}),
			stageOs: async (...args) => {
				await stageOsBundle(...args);
			},
			isOsStageReady: async () => true,
			readOsStageJob: async () => null,
			killAndRestartRaucForStream: async () => {},
			armOs: async () => {},
		}),
	);
	await checkUpdatesNow();
	// When Go Live aborts the exact attempt after positive exit but before publication.
	const installing = installUpdatesNow();
	if (!postSample && boundary !== "pending-proof") {
		await reached.promise;
		await admitAndPrepareStreamStart();
		resume.resolve();
	}
	const completion = await Promise.race([
		installing.then(() => "settled"),
		Bun.sleep(500).then(() => "pending"),
	]);
	expect(completion).toBe("settled");
	if (boundary === "pending-proof") {
		const before = remembers;
		pendingRead.resolve(
			await h.deps.observe({ processes: new Set(), resources: new Set() }),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(remembers).toBe(before);
		expect(h.events).not.toContain("release");
	}
	// Then unsafe survives D8, including another manual install request.
	expect(getOrchestratorState()).toMatchObject({
		phase: "failed",
		osStageRecovery: { mode: "unsafe", nextRetryAt: null, failedRounds: 1 },
	});
	await installUpdatesNow();
	expect(jobs).toBe(1);
	expect(dispatches).toBe(1);
	if (foreign) expect(foreign.exitCode).toBeNull();
});
