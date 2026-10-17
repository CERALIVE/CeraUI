import { setSysextEvidenceForTest } from "../../modules/addons/disruptive-sysext-step.ts";
import { setDisruptiveRetryClockForTest } from "../../modules/system/disruptive-retry.ts";
import { sysextFixture } from "../sysext-action-fixture.ts";

export const absentPid = () =>
	Object.assign(new Error("vanished"), { code: "ENOENT" });

export function completionFixture() {
	const owner = sysextFixture();
	const rows: Record<string, string | Error> = {
		"1": "/sbin/init\0",
		"42": "/usr/bin/bun\0worker\0",
	};
	const executables: Record<string, string | Error> = {
		"1": "/usr/lib/systemd/systemd",
		"42": "/usr/bin/bun",
	};
	const stats: Record<string, string> = {};
	const wakeups: Array<() => Promise<void>> = [];
	const state = {
		entries: ["1", "42"],
		lists: 0,
		read: (_pid: string) => undefined,
		list: () => undefined,
	};
	setSysextEvidenceForTest({
		procRoot: "/fixture-proc",
		procIo: {
			read: async (file) => {
				const pid = file.split("/").at(-2) ?? "";
				if (file.endsWith("/stat")) return stats[pid] ?? "invalid";
				state.read(pid);
				const row = rows[pid];
				if (row instanceof Error) throw row;
				if (row === undefined) throw absentPid();
				return row;
			},
			link: async (file) => {
				const exe = executables[file.split("/").at(-2) ?? ""];
				if (exe instanceof Error) throw exe;
				if (exe === undefined) throw absentPid();
				return exe;
			},
			list: async () => {
				state.lists++;
				state.list();
				return [...state.entries];
			},
		},
	});
	setDisruptiveRetryClockForTest({
		schedule: (run) => {
			wakeups.push(run);
			return () => undefined;
		},
	});
	return {
		rows,
		executables,
		stats,
		state,
		wakeups,
		wake: async () => {
			const run = wakeups.shift();
			if (!run) throw new Error("missing evidence wakeup");
			await run();
		},
		reset: () => {
			setDisruptiveRetryClockForTest(null);
			owner.reset();
		},
	};
}

export async function evidenceJobs(): Promise<void> {
	for (let index = 0; index < 200; index++) await Promise.resolve();
}
