import { expect, test } from "bun:test";
import {
	ensureHealthyStateForStage,
	type HealthyStateRefreshDeps,
} from "../modules/system/update-orchestrator/healthy-state-refresh.ts";
import { KernelUpdateError } from "../modules/system/update-orchestrator/kernel-state.ts";

type Mirror = "running" | "failed" | "idle";

function fixture(options: {
	matches: boolean[];
	restart?: boolean;
	restartError?: Error;
	mirrorStartError?: Error;
	mirror?: Mirror[];
}) {
	const calls: string[] = [];
	let clock = 0;
	const matches = [...options.matches];
	const mirror = [...(options.mirror ?? ["idle"])];
	const deps: HealthyStateRefreshDeps = {
		matches: async () => {
			calls.push("matches");
			return matches.length > 1 ? (matches.shift() as boolean) : matches[0];
		},
		restartHealthcheck: async () => {
			calls.push("restart");
			if (options.restartError) throw options.restartError;
			return options.restart ?? true;
		},
		startMirror: async () => {
			calls.push("mirror");
			if (options.mirrorStartError) throw options.mirrorStartError;
		},
		mirrorState: async () =>
			mirror.length > 1 ? (mirror.shift() as Mirror) : (mirror[0] as Mirror),
		sleep: async (ms) => {
			clock += ms;
		},
		now: () => clock,
	};
	return { deps, calls };
}

const failed = new KernelUpdateError("kernel_staging_failed");

test("a matching healthy-state record changes nothing", async () => {
	const f = fixture({ matches: [true] });
	await ensureHealthyStateForStage(f.deps);
	expect(f.calls).toEqual(["matches"]);
});

test("a stale record restarts the healthcheck, owns the mirror and waits for it", async () => {
	const f = fixture({
		matches: [false, true],
		mirror: ["running", "running", "idle"],
	});
	await ensureHealthyStateForStage(f.deps);
	expect(f.calls).toEqual(["matches", "restart", "mirror", "matches"]);
});

test("a mirror that finishes before it is ever seen running still settles after the grace window", async () => {
	const f = fixture({ matches: [false, true], mirror: ["idle"] });
	await ensureHealthyStateForStage(f.deps);
	expect(f.calls).toEqual(["matches", "restart", "mirror", "matches"]);
});

test("a failed healthcheck restart refuses before any mirror starts", async () => {
	const f = fixture({ matches: [false], restart: false });
	await expect(ensureHealthyStateForStage(f.deps)).rejects.toEqual(failed);
	expect(f.calls).toEqual(["matches", "restart"]);
});

test("a mirror that fails after running refuses the stage", async () => {
	const f = fixture({
		matches: [false, true],
		mirror: ["running", "failed"],
	});
	await expect(ensureHealthyStateForStage(f.deps)).rejects.toEqual(failed);
});

test("a mirror that fails without ever being seen running refuses the stage", async () => {
	const f = fixture({ matches: [false, true], mirror: ["failed"] });
	await expect(ensureHealthyStateForStage(f.deps)).rejects.toEqual(failed);
});

test("a healthcheck restart that throws is a staging failure that keeps its cause", async () => {
	const cause = new Error("timed out");
	const f = fixture({ matches: [false], restartError: cause });
	await expect(ensureHealthyStateForStage(f.deps)).rejects.toMatchObject({
		reason: "kernel_staging_failed",
		cause,
	});
	expect(f.calls).toEqual(["matches", "restart"]);
});

test("a mirror start that throws is a staging failure", async () => {
	const f = fixture({
		matches: [false],
		mirrorStartError: new Error("spawn failed"),
	});
	await expect(ensureHealthyStateForStage(f.deps)).rejects.toMatchObject({
		reason: "kernel_staging_failed",
	});
});

test("a record that still mismatches after the refresh refuses the stage", async () => {
	const f = fixture({ matches: [false, false], mirror: ["idle"] });
	await expect(ensureHealthyStateForStage(f.deps)).rejects.toEqual(failed);
});

test("a mirror that never stops running times out instead of waiting forever", async () => {
	const f = fixture({ matches: [false, true], mirror: ["running"] });
	await expect(ensureHealthyStateForStage(f.deps)).rejects.toEqual(failed);
});
