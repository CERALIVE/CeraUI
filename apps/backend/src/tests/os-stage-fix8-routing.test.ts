import { expect, test } from "bun:test";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import {
	createStageDeadline,
	withinStageDeadline,
} from "../modules/system/update-orchestrator/os-stage-deadline.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { reconcileOsStageStartup } from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { createUpdatePinController } from "../modules/system/update-transport/pin.ts";
import { sweepUpdateRules } from "../modules/system/update-transport/pin-rules.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";
import {
	record,
	harness as startupHarness,
} from "./helpers/os-stage-startup-harness.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

test("failed-pair routing teardown spends the remaining stage deadline and fences subsequent commands", async () => {
	// Given the actual runner and routing controller with a held first rule deletion.
	const h = await harness();
	let offset = 0;
	let hold = false;
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const commands: string[] = [];
	const pin = createUpdatePinController({
		readCapabilities: async () =>
			updateCapabilityFileSchema.parse({
				schema: 1,
				features: ["transport-uidrange"],
				apt_uid: 42042,
				ota_uid: 42043,
			}),
		run: async (_bin, args) => {
			const command = args.join(" ");
			commands.push(command);
			if (hold && command.includes("rule del")) {
				offset = 359_960;
				entered.resolve();
				await gate.promise;
			}
			return command.endsWith("route show default")
				? "default dev wlan0\n"
				: "";
		},
	});
	await pin.sweep();
	hold = true;
	const work = runOsStageJob(manifest, h.control, {
		...h.deps,
		pin,
		now: () => performance.now() + offset,
	}).then(
		() => "published",
		(error: unknown) => error,
	);
	try {
		expect(
			await Promise.race([
				entered.promise.then(() => "entered"),
				work.then(() => "settled-before-teardown"),
			]),
		).toBe("entered");
		// When a submitted deletion remains unresolved past the absolute recovery deadline.
		expect(
			await Promise.race([work, Bun.sleep(160).then(() => "pending")]),
		).toHaveProperty("mode", "unsafe");
		const submitted = commands.length;
		gate.resolve();
		await work;
		await Bun.sleep(0);
		// Then no second install, owner retirement or new cleanup command escapes.
		expect(h.attempts()).toBe(1);
		expect(h.events).not.toContain("release");
		expect(commands.length).toBe(submitted);
	} finally {
		hold = false;
		gate.resolve();
		await work;
	}
});

test("startup sweep refuses new commands when its held query resumes under surrendered CONTROL", async () => {
	// Given startup reconciliation using the actual rule sweep under a disposable lease.
	const h = startupHarness();
	let offset = 0;
	let held = false;
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const commands: string[] = [];
	const pin = createUpdatePinController({
		run: async (_bin, args) => {
			commands.push(`${held}:${args.join(" ")}`);
			if (args.join(" ") === "rule show") {
				entered.resolve();
				await gate.promise;
				return "120: from all uidrange 42043-42043 lookup 100001\n";
			}
			return "";
		},
	});
	const work = reconcileOsStageStartup({
		...h.deps,
		now: () => performance.now() + offset,
		acquireControl: async () => {
			const lease = await acquireTestOsStageControl();
			held = true;
			return {
				...lease,
				held: () => held,
				[Symbol.asyncDispose]: async () => {
					held = false;
					await lease[Symbol.asyncDispose]();
				},
			};
		},
		observe: async () => ({
			...record.baseline,
			instance: "660:20",
			processes: ["660:20"],
		}),
		cliGone: async () => true,
		sweep: async (...args) => {
			offset = 359_960;
			await pin.sweep(...args);
		},
	}).then(
		() => "reconciled",
		(error: unknown) => error,
	);
	try {
		expect(
			await Promise.race([
				entered.promise.then(() => "entered"),
				work.then(() => "settled-before-sweep"),
			]),
		).toBe("entered");
		// When startup times out and releases CONTROL before the query resolves.
		expect(
			await Promise.race([work, Bun.sleep(160).then(() => "pending")]),
		).toHaveProperty("mode", "unsafe");
		expect(held).toBe(false);
		gate.resolve();
		await Bun.sleep(0);
		// Then no deletion or flush is submitted by the abandoned sweep.
		expect(commands).toEqual(["true:rule show"]);
		expect(h.calls).not.toContain("release");
	} finally {
		gate.resolve();
		await work;
	}
});

test("sweep checks the final CONTROL fence even before the clock expires", async () => {
	// Given a live budget whose lease is surrendered while rule inspection is held.
	let held = true;
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const commands: string[] = [];
	const budget = createStageDeadline({
		deadline: performance.now() + 10_000,
		now: () => performance.now(),
		fence: () => {
			if (!held) throw new Error("CONTROL surrendered");
		},
	});
	const work = sweepUpdateRules(
		async (_bin, args) => {
			commands.push(args.join(" "));
			entered.resolve();
			await gate.promise;
			return "120: from all uidrange 42043-42043 lookup 100001\n";
		},
		(work) => withinStageDeadline(budget, work),
	).then(
		() => "swept",
		(error: unknown) => error,
	);
	try {
		await entered.promise;
		// When the lease changes without consuming the deadline.
		held = false;
		gate.resolve();
		expect(await work).toBeInstanceOf(Error);
		// Then the query is the only submitted command.
		expect(commands).toEqual(["rule show"]);
	} finally {
		gate.resolve();
		await work;
	}
});
