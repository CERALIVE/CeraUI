import { expect, test } from "bun:test";
import { observeAdmission } from "../modules/system/update-orchestrator/os-stage-admission-snapshot.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { recordStageFailure } from "../modules/system/update-orchestrator/os-stage-failure-context.ts";
import { reconcileOsStageStartup } from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { unlaunchedHarness } from "./helpers/os-stage-unlaunched-harness.ts";

test.each(["cause", "diagnostics", "reason"])(
	"admission rethrows original when diagnostic %s getter faults",
	async (property) => {
		const original = new OsStageError("os_transport_failed");
		Object.defineProperty(original, property, {
			get: () => {
				throw new TypeError("diagnostic fault");
			},
		});
		const caught = await observeAdmission(async () => {
			throw original;
		}).catch((error: unknown) => error);
		expect(caught).toBe(original);
	},
);

test.each(["cause", "diagnostics"])(
	"settlement rethrows original unsafe failure when %s getter faults",
	async (property) => {
		await using h = await unlaunchedHarness("absent");
		const original = new OsStageError("rauc_recovery_unproven");
		Object.defineProperty(original, property, {
			get: () => {
				throw new TypeError("diagnostic fault");
			},
		});
		const caught = await h
			.settle({
				observe: async () => {
					throw original;
				},
			})
			.catch((error: unknown) => error);
		expect(caught).toBe(original);
		expect(h.effects).toEqual([]);
	},
);
test.each(["cause", "diagnostics"])(
	"startup preserves original unsafe failure when %s getter faults",
	async (property) => {
		const original = new OsStageError("rauc_recovery_unproven");
		Object.defineProperty(original, property, {
			get: () => {
				throw new TypeError("diagnostic fault");
			},
		});
		let disposed = 0;
		const caught = await reconcileOsStageStartup({
			acquireControl: async () => ({
				held: () => true,
				[Symbol.asyncDispose]: async () => {
					disposed++;
				},
			}),
			readJob: async () => {
				throw original;
			},
		}).catch((error: unknown) => error);
		expect(caught).toBe(original);
		expect(disposed).toBe(1);
	},
);
test.each(["cause", "diagnostics"])(
	"bounded admission keeps original %s fault identity",
	async (property) => {
		const original = new OsStageError("rauc_recovery_unproven");
		Object.defineProperty(original, property, {
			get: () => {
				throw new TypeError("diagnostic fault");
			},
		});
		const caught = await observeAdmission(
			async () => {
				throw original;
			},
			undefined,
			{
				deadline: 250,
				now: () => 0,
				assert: async () => {},
				sleep: async () => {},
			},
		).catch((error: unknown) => error);
		expect(caught).toBe(original);
	},
);
test.each(["admission", "settlement-proof", "startup-recovery"] as const)(
	"%s annotation never replaces original under proxy property faults",
	(step) => {
		const original = new Proxy(new OsStageError("rauc_recovery_unproven"), {
			get: () => {
				throw new TypeError("diagnostic fault");
			},
		});
		expect(() => recordStageFailure(original, step)).not.toThrow();
	},
);
