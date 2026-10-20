import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { observeRaucStage } from "../../modules/system/update-orchestrator/os-stage-observation.ts";
import { drainRetainedOsStagePin } from "../../modules/system/update-orchestrator/os-stage-pin-retention.ts";
import { runOsStageJob } from "../../modules/system/update-orchestrator/os-stage-run.ts";
import { reconcileOsStageStartup } from "../../modules/system/update-orchestrator/os-stage-startup.ts";
import { rockHelperFixture } from "./os-stage-rock-helper-fixture.ts";
import { harness } from "./os-stage-run-harness.ts";
import { baseline, manifest } from "./os-stage-run-inputs.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";

export async function parkedDrain(
	boundary: "ownership" | "final-show",
	expires = true,
) {
	const h = await harness();
	const fixture = rockHelperFixture([]);
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let ready = false;
	let draining = false;
	let hold = true;
	let clock = 0;
	let remember = 0;
	let shows = 0;
	let child: ReturnType<typeof Bun.spawn> | undefined;
	let owner = h.deps.owner({
		schema: 1,
		attemptId: randomUUID(),
		candidateKey: "",
		bundleUrl: "",
		baseline,
		processes: [],
		resources: [],
		launched: false,
		cliSettled: true,
		requireNewInstance: false,
	});
	const wait = async () => {
		entered.resolve();
		await gate.promise;
	};
	const observe: typeof observeRaucStage = (tracked, _deps, report) =>
		observeRaucStage(
			tracked,
			{
				...fixture.deps,
				read: async (path) => {
					if (child && path.endsWith("cgroup.procs"))
						return `729106\n${child.pid}\n`;
					if (child && path.startsWith(`/proc/${child.pid}/`))
						return Bun.file(path).text();
					const raw = await fixture.deps.read(path);
					return ready && path === "/proc/729106/stat"
						? raw.replace("2374530", "2374531")
						: raw;
				},
				run: async (...args) => {
					if (
						args[0][0] === "systemctl" &&
						++shows % 2 === 0 &&
						draining &&
						hold &&
						boundary === "final-show"
					)
						await wait();
					return fixture.deps.run(...args);
				},
			},
			report,
		);
	const attemptId = randomUUID();
	await expect(
		runOsStageJob(
			manifest,
			{ ...h.control, attemptId },
			{
				...h.deps,
				observe,
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
				restart: async () => undefined,
				owner: (record) => {
					const original = h.deps.owner(record);
					owner = {
						...original,
						remember: (...args) => {
							remember++;
							original.remember(...args);
						},
						held: async () => {
							if (draining && hold && boundary === "ownership") await wait();
							return original.held();
						},
					};
					return owner;
				},
			},
		),
	).rejects.toHaveProperty("mode", "unsafe");
	ready = true;
	const beforeRemember = remember;
	let controlHeld = false;
	const now = () => clock + performance.now();
	const start = now();
	const startup = reconcileOsStageStartup({
		acquireControl: async () => {
			const lease = await acquireTestOsStageControl();
			controlHeld = true;
			return {
				...lease,
				held: () => controlHeld,
				[Symbol.asyncDispose]: async () => {
					controlHeld = false;
					await lease[Symbol.asyncDispose]();
				},
			};
		},
		readJob: async () => owner.record(),
		owner: () => owner,
		run: async () => ({
			exitCode: 0,
			stdout: "LoadState=loaded\n",
			stderr: "",
		}),
		observe,
		cliGone: async () => true,
		restart: async () => undefined,
		now,
		sleep: async (ms) => {
			clock += ms;
		},
		drain: async (...args) => {
			draining = true;
			if (expires) clock = start + 359_960 - performance.now();
			await drainRetainedOsStagePin(...args);
		},
		sweep: () => h.deps.pin.sweep(),
	}).then(
		() => "reconciled",
		(error: unknown) => error,
	);
	return {
		h,
		entered,
		gate,
		startup,
		owner,
		attemptId,
		remember: () => remember - beforeRemember,
		controlHeld: () => controlHeld,
		introduceChild: () => {
			child = Bun.spawn(["bash", "-c", "read -r line"], {
				stdin: "pipe",
				stdout: "ignore",
				stderr: "ignore",
			});
		},
		cleanup: async () => {
			hold = false;
			gate.resolve();
			await startup;
			if (child) {
				child.kill();
				await child.exited;
				child = undefined;
			}
			await drainRetainedOsStagePin(attemptId, {
				deadline: performance.now() + 10_000,
				now: () => performance.now(),
			});
			await h.deps.pin.sweep();
		},
	};
}
