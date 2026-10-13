import { afterEach, beforeEach, expect, test } from "bun:test";
import { AsyncResource } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addonEnable, addonRefresh } from "../helpers/addon-helper.ts";
import { SpawnTimeoutError } from "../helpers/bounded-spawn.ts";
import {
	currentSysextOperation,
	probeSysextActors,
	runDisruptiveSysextStep,
	setSysextEvidenceForTest,
} from "../modules/addons/disruptive-sysext-step.ts";
import { DisruptiveActionRefusedError } from "../modules/system/disruptive-action-error.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { setDisruptiveRetryClockForTest } from "../modules/system/disruptive-retry.ts";
import type { ServiceCompletion } from "../modules/system/disruptive-service-reservation.ts";
import { submitPowerCommand } from "../modules/system/power-submission.ts";
import { sysextFixture } from "./sysext-action-fixture.ts";
import { heldBoundary } from "./sysext-tail-fixture.ts";

let f: ReturnType<typeof sysextFixture>;
let wakeups: Array<() => Promise<void>>;
let probeAnswer: ServiceCompletion;
let probes: string[];
beforeEach(() => {
	f = sysextFixture();
	wakeups = [];
	probeAnswer = "completed";
	probes = [];
	setDisruptiveRetryClockForTest({
		schedule: (run) => {
			wakeups.push(run);
			return () => undefined;
		},
	});
	setSysextEvidenceForTest({
		probe: async (scope) => {
			probes.push(scope.unit);
			return probeAnswer;
		},
	});
});
afterEach(() => {
	setDisruptiveRetryClockForTest(null);
	f.reset();
});

async function jobs(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}
const device = (exec: () => Promise<{ stdout: string; stderr: string }>) => ({
	isRealDevice: async () => true,
	exec,
});
async function refusal(work: Promise<unknown>): Promise<string> {
	const error = await work.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	if (!(error instanceof DisruptiveActionRefusedError))
		throw new Error(`expected a typed refusal, got ${String(error)}`);
	return error.reason;
}

test("nested helper and unit steps re-enter one active owner and release only at the outermost level", async () => {
	// Given one outer add-on operation submitting a helper and then a unit step.
	const pendingDuring: boolean[] = [];
	const owners: Array<symbol | undefined> = [];
	await runDisruptiveSysextStep("enable:cog-display", async () => {
		owners.push(currentSysextOperation()?.id);
		await addonEnable(
			"cog-display",
			device(async () => {
				owners.push(currentSysextOperation()?.id);
				return { stdout: "{}", stderr: "" };
			}),
		);
		pendingDuring.push(isDisruptiveActionPending());
		await runDisruptiveSysextStep(
			"start-addon-unit",
			async () => {
				owners.push(currentSysextOperation()?.id);
			},
			{ unit: "cog.service" },
		);
		// When an unrelated reboot is requested between the nested depths.
		const reboot = submitPowerCommand("reboot", () => {
			throw new Error("reboot must not run");
		});
		expect(reboot).toEqual({ success: false, error: "update_in_progress" });
		pendingDuring.push(isDisruptiveActionPending());
	});
	// Then every depth shared one owner and admission reopened only afterwards.
	expect(new Set(owners).size).toBe(1);
	expect(owners).toHaveLength(3);
	expect(pendingDuring).toEqual([true, true]);
	expect(isDisruptiveActionPending()).toBe(false);
});

test("a different operation is refused while another holds and admitted after its release", async () => {
	// Given operation A held inside its helper submission.
	const held = heldBoundary();
	const first = addonRefresh(
		device(async () => {
			await held.wait();
			return { stdout: "", stderr: "" };
		}),
	);
	await held.entered;
	const effects: string[] = [];
	// When operation B asks for its own refresh.
	const refused = await refusal(
		addonRefresh(
			device(async () => {
				effects.push("second");
				return { stdout: "", stderr: "" };
			}),
		),
	);
	held.release();
	await first;
	await addonRefresh(
		device(async () => {
			effects.push("third");
			return { stdout: "", stderr: "" };
		}),
	);
	// Then B never ran under A's hold and a later operation is serialized after it.
	expect(refused).toBe("update_in_progress");
	expect(effects).toEqual(["third"]);
	expect(isDisruptiveActionPending()).toBe(false);
});

test("a timer descendant of a released operation is refused and mints no owner", async () => {
	// Given a descendant created inside an operation that has since completed.
	let descendant: AsyncResource | undefined;
	await runDisruptiveSysextStep("kiosk-start", async () => {
		descendant = new AsyncResource("late-timer");
	});
	if (!descendant) throw new Error("missing descendant");
	const effects: string[] = [];
	// When the descendant later requests a sysext refresh.
	const reason = await refusal(
		descendant.runInAsyncScope(() =>
			runDisruptiveSysextStep("refresh-addon", async () => {
				effects.push("refresh");
			}),
		),
	);
	// Then it is refused and the device stays free for genuine owners.
	expect(reason).toBe("update_in_progress");
	expect(effects).toEqual([]);
	expect(isDisruptiveActionPending()).toBe(false);
	descendant.emitDestroy();
});

test("an add-on refresh is refused while a reboot is pending", async () => {
	// Given an accepted reboot whose shutdown hold survives submission.
	const runs: string[] = [];
	expect(submitPowerCommand("reboot", (command) => runs.push(command))).toEqual(
		{
			success: true,
		},
	);
	const helper: string[] = [];
	// When an add-on refresh is requested.
	const reason = await refusal(
		addonRefresh(
			device(async () => {
				helper.push("refresh");
				return { stdout: "", stderr: "" };
			}),
		),
	);
	// Then the helper is never submitted.
	expect(runs).toEqual(["reboot"]);
	expect(reason).toBe("update_in_progress");
	expect(helper).toEqual([]);
});

test("a reboot requested during an add-on refresh is refused and accepted after release", async () => {
	// Given a refresh held inside its privileged helper.
	const held = heldBoundary();
	const refresh = addonRefresh(
		device(async () => {
			await held.wait();
			return { stdout: "", stderr: "" };
		}),
	);
	await held.entered;
	const runs: string[] = [];
	// When reboot is requested during and after the refresh.
	const during = submitPowerCommand("reboot", (command) => runs.push(command));
	held.release();
	await refresh;
	const after = submitPowerCommand("reboot", (command) => runs.push(command));
	// Then only the post-release request reaches the power runner.
	expect(during).toEqual({ success: false, error: "update_in_progress" });
	expect(after).toEqual({ success: true });
	expect(runs).toEqual(["reboot"]);
});

test("a positive helper failure releases its hold immediately", async () => {
	// Given a helper that exits non-zero.
	const failure = Object.assign(new Error("Command failed"), { code: 1 });
	// When the refresh rejects.
	const error = await addonRefresh(
		device(async () => {
			throw failure;
		}),
	).catch((caught: unknown) => caught);
	// Then the original error surfaces and no completion probe was needed.
	expect(error).toBe(failure);
	expect(probes).toEqual([]);
	expect(isDisruptiveActionPending()).toBe(false);
});

test("an untyped exception releases only after positive completion evidence", async () => {
	// Given an exception carrying no exit status.
	probeAnswer = "in-flight";
	await addonRefresh(
		device(async () => {
			throw new Error("connection reset");
		}),
	).catch(() => undefined);
	await jobs();
	const heldAfterFirstProbe = isDisruptiveActionPending();
	// When the next evidence wakeup observes no remaining sysext actor.
	probeAnswer = "completed";
	const wake = wakeups.shift();
	if (!wake) throw new Error("missing evidence wakeup");
	await wake();
	// Then the hold is released by that evidence.
	expect(heldAfterFirstProbe).toBe(true);
	expect(probes).toEqual(["sysext:helper:refresh", "sysext:helper:refresh"]);
	expect(isDisruptiveActionPending()).toBe(false);
});

test("a systemd-sysext refresh timeout holds through bare timer wakeups and releases on evidence", async () => {
	// Given a refresh whose bounded helper call timed out.
	probeAnswer = "unknown";
	const error = await addonRefresh(
		device(async () => {
			throw new SpawnTimeoutError("sudo ceralive-addon-helper refresh");
		}),
	).catch((caught: unknown) => caught);
	await jobs();
	// When two timer wakeups bring no positive evidence.
	for (const answer of ["in-flight", "unknown"] as const) {
		probeAnswer = answer;
		const wake = wakeups.shift();
		if (!wake) throw new Error("missing evidence wakeup");
		await wake();
		expect(isDisruptiveActionPending()).toBe(true);
	}
	const refused = await refusal(
		addonRefresh(device(async () => ({ stdout: "", stderr: "" }))),
	);
	probeAnswer = "completed";
	const wake = wakeups.shift();
	if (!wake) throw new Error("missing evidence wakeup");
	await wake();
	// Then the timeout surfaced, the hold refused a new refresh, and evidence released it.
	expect(error).toBeInstanceOf(SpawnTimeoutError);
	expect(refused).toBe("update_in_progress");
	expect(probes).toHaveLength(4);
	expect(isDisruptiveActionPending()).toBe(false);
});

test("a unit step settles through its own unit, not the helper process table", async () => {
	// Given a unit stop whose systemctl client timed out.
	probeAnswer = "in-flight";
	await runDisruptiveSysextStep(
		"stop-addon-unit",
		async () => {
			throw new SpawnTimeoutError("systemctl stop cog.service");
		},
		{ unit: "cog.service" },
	).catch(() => undefined);
	await jobs();
	// When that unit later reports a settled lifecycle.
	probeAnswer = "completed";
	const wake = wakeups.shift();
	if (!wake) throw new Error("missing evidence wakeup");
	await wake();
	// Then the probe named the unit itself.
	expect(probes).toEqual(["cog.service", "cog.service"]);
	expect(isDisruptiveActionPending()).toBe(false);
});

test("the default helper probe needs a visible process table free of sysext actors", async () => {
	// Given private process tables in four shapes.
	const root = mkdtempSync(join(tmpdir(), "sysext-proc-"));
	const table = (name: string, rows: Record<string, string>) => {
		const dir = join(root, name);
		mkdirSync(dir);
		for (const [pid, argv] of Object.entries(rows)) {
			mkdirSync(join(dir, pid));
			writeFileSync(join(dir, pid, "cmdline"), argv);
		}
		return dir;
	};
	const shapes = {
		filtered: table("filtered", { "42": "bash\0" }),
		idle: table("idle", { "1": "/sbin/init\0", "7": "bun\0", self: "x\0" }),
		helper: table("helper", {
			"1": "/sbin/init\0",
			"9": "sudo\0ceralive-addon-helper\0refresh\0",
		}),
		descendant: table("descendant", {
			"1": "/sbin/init\0",
			"11": "/usr/bin/systemd-sysext\0refresh\0",
		}),
	};
	const results: Record<string, ServiceCompletion> = {};
	try {
		// When the production probe reads each table.
		for (const [name, dir] of Object.entries(shapes)) {
			setSysextEvidenceForTest({ procRoot: dir });
			results[name] = await probeSysextActors(
				undefined,
				new AbortController().signal,
			);
		}
		const aborted = new AbortController();
		aborted.abort();
		setSysextEvidenceForTest({ procRoot: shapes.idle });
		results.aborted = await probeSysextActors(undefined, aborted.signal);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	// Then only a visible, actor-free table proves completion.
	expect(results).toEqual({
		filtered: "unknown",
		idle: "completed",
		helper: "in-flight",
		descendant: "in-flight",
		aborted: "unknown",
	});
});
