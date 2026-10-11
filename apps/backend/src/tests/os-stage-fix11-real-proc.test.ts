import { expect, test } from "bun:test";
import { open } from "node:fs/promises";
import {
	observeStageCensus,
	readStageProcess,
} from "../modules/system/update-orchestrator/os-stage-census.ts";
import { defaultRaucObservationDeps } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { rockHelperFixture } from "./helpers/os-stage-rock-helper-fixture.ts";

test("a held-open stat read after real task reap contributes no cached identity", async () => {
	// Given a real child, its earlier identity and an unread stat handle opened while alive.
	const child = Bun.spawn(["/bin/sleep", "60"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const pid = String(child.pid);
	const fixture = rockHelperFixture([]);
	try {
		const earlier = await readStageProcess(pid, {
			...fixture.deps,
			read: defaultRaucObservationDeps.read,
		});
		if (!earlier) throw new Error("live child identity unavailable");
		const handle = await open(`/proc/${pid}/stat`, "r");
		try {
			child.kill("SIGKILL");
			await child.exited;
			const failures: unknown[] = [];
			const deps = {
				...fixture.deps,
				read: async (path: string) => {
					if (path.endsWith("cgroup.procs")) return `${pid}\n`;
					if (path !== `/proc/${pid}/stat`) return fixture.deps.read(path);
					try {
						return await handle.readFile("utf8");
					} catch (error) {
						failures.push(error);
						throw error;
					}
				},
			};
			// When the production reader and tracked-member census read that retired task handle.
			const identity = await readStageProcess(pid, deps);
			const census = await observeStageCensus({
				deps,
				tracked: { processes: new Set([earlier]), resources: new Set() },
				group: "/system.slice/rauc.service",
				at: () => {},
			});
			// Then the actual kernel errno is absence, never a fabricated or cached member.
			expect(failures).toHaveLength(2);
			for (const error of failures)
				expect(error).toMatchObject({ code: "ESRCH", syscall: "read" });
			expect(identity).toBeNull();
			expect(census?.processIds.size).toBe(0);
		} finally {
			await handle.close();
		}
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
});

test("bounded real default-reader exit stress never throws a census error", async () => {
	// Given actual short-lived children and the unchanged production default reader.
	const fixture = rockHelperFixture([]);
	const errnos = new Map<string, number>();
	const failures: unknown[] = [];
	let reads = 0;
	let gone = 0;
	const deps = {
		...fixture.deps,
		read: async (path: string) => {
			reads++;
			try {
				return await defaultRaucObservationDeps.read(path);
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					typeof error.code === "string"
				)
					errnos.set(error.code, (errnos.get(error.code) ?? 0) + 1);
				throw error;
			}
		},
	};
	const deadline = performance.now() + 4_000;
	// When the real census reader races bounded exit/reaping without synthetic errors.
	for (let batch = 0; batch < 64 && performance.now() < deadline; batch++) {
		const children = Array.from({ length: 16 }, () =>
			Bun.spawn(["/usr/bin/true"], { stdout: "ignore", stderr: "ignore" }),
		);
		try {
			await Promise.all(
				children.flatMap((child) =>
					Array.from({ length: 16 }, async () => {
						try {
							if ((await readStageProcess(String(child.pid), deps)) === null)
								gone++;
						} catch (error) {
							failures.push(error);
						}
					}),
				),
			);
		} finally {
			await Promise.all(children.map((child) => child.exited));
		}
	}
	// Then no error escapes; occurrence counts are evidence, not a kernel-race gate.
	console.info("real proc race", {
		reads,
		gone,
		errnos: Object.fromEntries(errnos),
		failures: failures.length,
	});
	expect(failures).toEqual([]);
}, 10_000);
