import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIdleStatus } from "../modules/system/idle-activity.ts";
import { evaluateIdle } from "../modules/system/idle-detector.ts";
import {
	getIdleMemory,
	notePreviewEnded,
	setIdleStateFilePathForTest,
} from "../modules/system/idle-state.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

let root: string;
let path: string;
let installs = 0;
const now = getIdleMemory().bootAt + 60 * 60_000;
const schedule = { mode: "any-idle", start: "03:00", end: "05:00" } as const;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "idle-authority-"));
	path = join(root, "idle.json");
	installs = 0;
	setIdleStateFilePathForTest(path);
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			now: () => now,
			isIdle: async () => (await getIdleStatus({ now, schedule })).idle,
			quarantine: testQuarantine(),
			startPackageInstall: () => {
				installs++;
				return { started: true };
			},
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(now),
		phase: "awaiting-idle",
	});
});

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setIdleStateFilePathForTest(null);
	rmSync(root, { recursive: true, force: true });
	for (const dir of quarantineDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

for (const kind of ["future", "nonfinite"] as const) {
	test.each(["stream", "preview", "remote", "ui", "startLease"] as const)(
		`${kind} %s activity cannot grant idle through an older sibling signal`,
		(key) => {
			// Given known old activity alongside one temporally unproven signal.
			const quiet = {
				stream: now - 31 * 60_000,
				preview: now - 32 * 60_000,
				remote: now - 33 * 60_000,
				ui: now - 34 * 60_000,
				startLease: now - 35 * 60_000,
			};
			// When the shared production idle predicate evaluates all sources.
			const result = evaluateIdle({
				now,
				schedule,
				idleMinutes: 30,
				lastActivity: {
					...quiet,
					[key]: kind === "future" ? now + 60_000 : Number.NaN,
				},
			});
			// Then an older valid source cannot mask unknown recency.
			expect(result).toEqual({
				idle: false,
				since: null,
				blockers: ["activity-unknown"],
			});
		},
	);
}

const ambiguous = [
	["future", `{"lastStreamEndedAt":${now + 60_000}}`],
	[
		"duplicate",
		`{"lastStreamEndedAt":${now - 60_000},"lastStreamEndedAt":null}`,
	],
	[
		"escaped-duplicate",
		`{"lastStreamEndedAt":${now - 60_000},"lastStreamEnded\\u0041t":null}`,
	],
	["truncated", `{"lastStreamEndedAt":${now - 60_000}`],
	["wrong-type", '{"lastStreamEndedAt":"yesterday"}'],
	["missing-field", "{}"],
	["bom", '\uFEFF{"lastStreamEndedAt":null}'],
	["oversize", `${" ".repeat(16_385)}{"lastStreamEndedAt":null}`],
] as const;

test.each(ambiguous)(
	"scheduler submits zero installs when idle authority is %s",
	async (_label, bytes) => {
		// Given corrupt stored idle authority, but otherwise eligible idle inputs.
		writeFileSync(path, bytes);
		if (_label === "future") notePreviewEnded(now - 31 * 60_000);
		// When the real scheduler evaluates a queued install.
		await runOrchestratorTick();
		// Then ambiguity neither grants idle nor destroys its evidence.
		expect(installs).toBe(0);
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		expect(await getIdleStatus({ now, schedule })).toEqual({
			idle: false,
			since: null,
			blockers: ["activity-unknown"],
		});
		expect(readFileSync(path, "utf8")).toBe(bytes);
	},
);

test.each(["directory", "fifo", "dangling-link", "invalid-utf8"])(
	"scheduler submits zero installs when idle authority is %s",
	async (layout) => {
		// Given a present unreadable/non-regular authority entry.
		if (layout === "directory") mkdirSync(path);
		else if (layout === "fifo")
			expect((await runTestCommand(["mkfifo", path])).code).toBe(0);
		else if (layout === "dangling-link") symlinkSync("missing.json", path);
		else writeFileSync(path, Buffer.from([0xff]));
		const inode = lstatSync(path).ino;
		// When the real scheduler evaluates idle.
		await runOrchestratorTick();
		// Then the entry remains present and permission is withheld.
		expect(installs).toBe(0);
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		expect((await getIdleStatus({ now, schedule })).blockers).toEqual([
			"activity-unknown",
		]);
		expect(lstatSync(path).ino).toBe(inode);
	},
);

test("scheduler retains the recent-activity control", async () => {
	// Given valid recent stream activity.
	writeFileSync(path, JSON.stringify({ lastStreamEndedAt: now - 60_000 }));
	// When the scheduler evaluates the install.
	await runOrchestratorTick();
	// Then a clean recent record still blocks it.
	expect(installs).toBe(0);
	expect(getOrchestratorState().phase).toBe("awaiting-idle");
});

test.each(["absent", "valid-null", "old-activity"])(
	"scheduler can install when positive idle evidence is %s",
	async (layout) => {
		// Given genuine first boot or a valid record, beyond the boot idle window.
		if (layout !== "absent")
			writeFileSync(
				path,
				JSON.stringify({
					lastStreamEndedAt: layout === "valid-null" ? null : now - 31 * 60_000,
				}),
			);
		// When the scheduler evaluates the install.
		await runOrchestratorTick();
		// Then genuine absence is not confused with corrupt presence.
		expect(installs).toBe(1);
		expect(getOrchestratorState().phase).toBe("downloading");
	},
);

test("invalid reads never cache defaults before a storage repair", async () => {
	// Given an invalid read followed by an independently repaired recent record.
	writeFileSync(path, '{"lastStreamEndedAt":');
	await getIdleStatus({ now, schedule });
	writeFileSync(path, JSON.stringify({ lastStreamEndedAt: now - 60_000 }));
	// When the scheduler re-evaluates without a process reset.
	await runOrchestratorTick();
	// Then the repaired activity is read, rather than a cached null/default.
	expect(installs).toBe(0);
	expect((await getIdleStatus({ now, schedule })).blockers).toEqual(["stream"]);
});
