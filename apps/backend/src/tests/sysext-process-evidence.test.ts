import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	probeSysextActors,
	runDisruptiveSysextStep,
	setSysextEvidenceForTest,
} from "../modules/addons/disruptive-sysext-step.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { setDisruptiveRetryClockForTest } from "../modules/system/disruptive-retry.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { sysextFixture } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
let fixture: ReturnType<typeof sysextFixture>;
let rows: Record<string, string | Error>;
let entries: string[];
let wakeups: Array<() => Promise<void>>;

beforeEach(() => {
	fixture = sysextFixture();
	rows = { "1": "/sbin/init\0", "42": "/usr/bin/bun\0worker\0" };
	entries = ["1", "42", "self"];
	wakeups = [];
	// Literal per-PID rows and read faults at the process-table boundary.
	setSysextEvidenceForTest({
		procRoot: "/fixture-proc",
		procIo: {
			read: async (file) => {
				const row = rows[file.split("/").at(-2) ?? ""];
				if (row instanceof Error) {
					if ("code" in row && ["ENOENT", "ESRCH"].includes(String(row.code)))
						entries = entries.filter((pid) => pid !== file.split("/").at(-2));
					throw row;
				}
				if (row === undefined)
					throw Object.assign(new Error("vanished"), { code: "ENOENT" });
				return row;
			},
			list: async () => entries,
			link: async (file) => {
				const row = rows[file.split("/").at(-2) ?? ""];
				if (row instanceof Error) throw row;
				if (row === undefined)
					throw Object.assign(new Error("vanished"), { code: "ENOENT" });
				return row.split("\0")[0] ?? "";
			},
		},
	});
	setDisruptiveRetryClockForTest({
		schedule: (run) => {
			wakeups.push(run);
			return () => undefined;
		},
	});
});
afterEach(() => {
	setDisruptiveRetryClockForTest(null);
	fixture.reset();
});

async function jobs(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

for (const code of ["EIO", "EACCES"] as const) {
	test(`an enumerated PID read ${code} is unknown, not completion`, async () => {
		// Given PID 1 is readable but an enumerated actor row cannot be read.
		rows["42"] = Object.assign(new Error("read failed"), { code });
		// When the real helper probe observes the table.
		const answer = await probeSysextActors(
			undefined,
			new AbortController().signal,
		);
		// Then lack of a readable identity cannot prove disappearance.
		expect(answer).toBe("unknown");
	});
	test(`the production sysext reservation retains ${code} through retries until a complete readable observation`, async () => {
		// Given a helper outcome is uncertain and another enumerated row is unreadable.
		rows["42"] = Object.assign(new Error("read failed"), { code });
		const failure = new Error("uncertain helper outcome");
		const error = await runDisruptiveSysextStep("refresh", async () => {
			throw failure;
		}).catch((caught: unknown) => caught);
		await jobs();
		expect(error).toBe(failure);
		expect(isDisruptiveActionPending()).toBe(true);
		// When two retry wakeups still cannot read it, then all rows become readable.
		for (let i = 0; i < 2; i++) {
			const wake = wakeups.shift();
			if (!wake) throw new Error("missing observation wakeup");
			await wake();
			expect(isDisruptiveActionPending()).toBe(true);
		}
		rows["42"] = "/usr/bin/bun\0worker\0";
		const wake = wakeups.shift();
		if (!wake) throw new Error("missing final observation wakeup");
		await wake();
		// Then positive completion alone reopens the real reservation.
		expect(isDisruptiveActionPending()).toBe(false);
		expect(wakeups).toEqual([]);
	});
}

for (const code of ["ENOENT", "ESRCH"] as const) {
	test(`an enumerated PID that vanishes with ${code} is skipped`, async () => {
		// Given the sole non-init process disappears during its cmdline read.
		rows["42"] = Object.assign(new Error("vanished"), { code });
		// When the actual probe and reservation observe that scoped disappearance.
		const answer = await probeSysextActors(
			undefined,
			new AbortController().signal,
		);
		await runDisruptiveSysextStep("refresh", async () => {
			throw new Error("uncertain");
		}).catch(() => undefined);
		await jobs();
		// Then the remaining complete readable table establishes retirement.
		expect(answer).toBe("completed");
		expect(isDisruptiveActionPending()).toBe(false);
	});
}

for (const row of [
	"",
	Object.assign(new Error("filtered"), { code: "EACCES" }),
]) {
	test(`PID 1 ${typeof row === "string" ? "empty" : "unreadable"} keeps the sysext hold unknown`, async () => {
		// Given PID 1 cannot establish a visible process table.
		rows["1"] = row;
		// When the production probe settles an uncertain step.
		const answer = await probeSysextActors(
			undefined,
			new AbortController().signal,
		);
		await runDisruptiveSysextStep("refresh", async () => {
			throw new Error("uncertain");
		}).catch(() => undefined);
		await jobs();
		// Then no actor-free conclusion or clearance is permitted.
		expect(answer).toBe("unknown");
		expect(isDisruptiveActionPending()).toBe(true);
	});
}

for (const [argv, expected] of [
	["/usr/bin/journalctl\0-f\0-u\0systemd-sysext\0", "completed"],
	["sudo\0journalctl\0-f\0-u\0systemd-sysext\0", "completed"],
	["/usr/bin/printf\0ceralive-addon-helper\0", "completed"],
	["sudo\0-n\0--\0journalctl\0-u\0systemd-sysext\0", "completed"],
	["/usr/bin/systemd-sysext\0refresh\0", "in-flight"],
	["/usr/sbin/ceralive-addon-helper\0enable\0cog-display\0", "in-flight"],
	["sudo\0-n\0--\0/usr/bin/systemd-sysext\0refresh\0", "in-flight"],
	["sudo\0-u\0root\0/usr/sbin/ceralive-addon-helper\0refresh\0", "in-flight"],
	["/bin/bash\0/usr/sbin/ceralive-addon-helper\0refresh\0", "in-flight"],
	["/bin/bash\0-c\0printf ceralive-addon-helper\0", "completed"],
	["/usr/bin/cat\0/usr/sbin/ceralive-addon-helper\0", "completed"],
] as const) {
	test(`literal executable identity ${JSON.stringify(argv)} yields ${expected}`, async () => {
		// Given an argv row, not a process name guessed from its arguments.
		rows["42"] = argv;
		// When the production probe reads its executable identity.
		const answer = await probeSysextActors(
			undefined,
			new AbortController().signal,
		);
		// Then observers are not actors, while direct and sudo target commands are.
		expect(answer).toBe(expected);
	});
}
