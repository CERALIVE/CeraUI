import { afterEach, expect, spyOn, test } from "bun:test";
import type { Subprocess } from "bun";
import * as runner from "../helpers/run.ts";
import { clearAll } from "../modules/device-logs/retention.ts";
import {
	getOrchestratorState,
	installUpdatesNow,
} from "../modules/system/update-orchestrator/runtime.ts";
import { bounded, historyFixture } from "./helpers/history-clear.ts";
import {
	cleanScopedFixture,
	scopedFixture,
} from "./helpers/package-scoped-install.ts";

let h: ReturnType<typeof historyFixture>;
const realRun = runner.run;
afterEach(async () => {
	try {
		await h?.dispose();
	} finally {
		cleanScopedFixture();
	}
});

test.each(["timeout", "TERM failure"] as const)(
	"native clear holds update admission through vacuum %s until reap",
	async (failure) => {
		h = historyFixture(false);
		const update = scopedFixture();
		h.f.phase.mockRestore();
		const exit = Promise.withResolvers<number>();
		const stdout = new ReadableStream<Uint8Array<ArrayBuffer>>();
		const stderr = new ReadableStream<Uint8Array<ArrayBuffer>>();
		const signals: (number | NodeJS.Signals | undefined)[] = [];
		const unused = () => {
			throw new Error("unexpected subprocess operation");
		};
		const child = {
			stdin: undefined,
			stdout,
			stderr,
			readable: stdout,
			terminal: undefined,
			stdio: [null, null, null],
			pid: 1,
			exited: exit.promise,
			exitCode: null,
			signalCode: null,
			killed: false,
			kill(signal) {
				signals.push(signal);
				if (signal === "SIGTERM" && failure === "TERM failure")
					throw new Error("TERM signal failed");
			},
			ref: unused,
			unref: unused,
			send: unused,
			disconnect: unused,
			resourceUsage: unused,
			[Symbol.asyncDispose]: unused,
		} satisfies Subprocess<"ignore", "pipe", "pipe">;
		const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(child);
		h.f.run
			.mockImplementationOnce(async () => "")
			.mockImplementationOnce((cmd, args, opts) =>
				realRun(cmd, args, { ...opts, timeout: 0 }),
			);
		try {
			expect(await bounded(h.own(clearAll()))).toEqual({
				ok: false,
				error: "READ_FAILED",
			});
			expect(signals).toEqual(
				failure === "timeout" ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"],
			);
			expect(await bounded(installUpdatesNow({ scope: "packages" }))).toEqual({
				started: false,
				reason: "busy",
			});
			expect(update.launches()).toBe(0);

			exit.resolve(137);
			await exit.promise;
			expect(await bounded(installUpdatesNow({ scope: "packages" }))).toEqual({
				started: true,
			});
			expect(update.launches()).toBe(1);
		} finally {
			exit.resolve(137);
			spawn.mockRestore();
		}
	},
);

test("native clear excludes update admission until rotation and vacuum settle", async () => {
	h = historyFixture(false);
	const update = scopedFixture();
	h.f.phase.mockRestore();
	const rotation = h.holdRotate();
	const vacuum = h.ownedLatch();
	let phaseAtVacuum: string | undefined;
	h.journal.vacuum = async () => {
		phaseAtVacuum = getOrchestratorState().phase;
		await vacuum.hold();
	};
	const clearing = h.own(clearAll());
	try {
		await bounded(rotation.entered);
		const duringRotation = await bounded(
			installUpdatesNow({ scope: "packages" }),
		);
		rotation.release();
		await bounded(vacuum.entered);
		const duringVacuum = await bounded(
			installUpdatesNow({ scope: "packages" }),
		);
		vacuum.release();
		expect((await bounded(clearing)).ok).toBe(true);
		expect(phaseAtVacuum).toBe("available");
		expect(duringRotation).toEqual({ started: false, reason: "busy" });
		expect(duringVacuum).toEqual({ started: false, reason: "busy" });
		expect(update.launches()).toBe(0);
		expect(await bounded(installUpdatesNow({ scope: "packages" }))).toEqual({
			started: true,
		});
		expect(update.launches()).toBe(1);
	} finally {
		rotation.release();
		vacuum.release();
		await bounded(clearing);
	}
});
