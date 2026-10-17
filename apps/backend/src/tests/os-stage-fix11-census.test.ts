import { expect, test } from "bun:test";
import { observeStageCensus } from "../modules/system/update-orchestrator/os-stage-census.ts";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { rockHelperFixture } from "./helpers/os-stage-rock-helper-fixture.ts";

test.each(["", "\n", " \t\n "])(
	"blank roster %j never reads /proc//stat or invents identity",
	async (raw) => {
		// Given an empty cgroup roster and no tracked members.
		const fixture = rockHelperFixture([]);
		const paths: string[] = [];
		const deps = {
			...fixture.deps,
			read: async (path: string) => {
				paths.push(path);
				return path.endsWith("cgroup.procs") ? raw : fixture.deps.read(path);
			},
		};
		// When the production census observes the roster.
		const census = await observeStageCensus({
			deps,
			tracked: { processes: new Set(), resources: new Set() },
			group: "/system.slice/rauc.service",
			at: () => {},
		});
		// Then no blank token becomes a process path or identity.
		expect(paths).not.toContain("/proc//stat");
		expect(census?.pids).toEqual([]);
		expect(census?.processIds.size).toBe(0);
	},
);

test.each(["not-a-pid", "0", "729106\n../stat"])(
	"invalid roster %j remains unproven before PID reads",
	async (raw) => {
		// Given a malformed nonblank PID token.
		const fixture = rockHelperFixture([]);
		const paths: string[] = [];
		const deps = {
			...fixture.deps,
			read: async (path: string) => {
				paths.push(path);
				return raw;
			},
		};
		// When the production census parses that boundary.
		const census = await observeStageCensus({
			deps,
			tracked: { processes: new Set(), resources: new Set() },
			group: "/system.slice/rauc.service",
			at: () => {},
		});
		// Then malformed input produces no authorizing census and no process lookup.
		expect(census).toBeNull();
		expect(paths).toEqual([
			"/sys/fs/cgroup/system.slice/rauc.service/cgroup.procs",
		]);
	},
);

test.each(["ENOENT", "ESRCH"])(
	"missing daemon %s still refuses despite a blank roster",
	async (code) => {
		// Given an absent MainPID and an empty cgroup roster.
		const fixture = rockHelperFixture([]);
		const deps = {
			...fixture.deps,
			read: async (path: string) => {
				if (path === "/proc/729106/stat")
					throw Object.assign(new Error("gone"), { code });
				return path.endsWith("cgroup.procs") ? "" : fixture.deps.read(path);
			},
		};
		// When the full production observer checks daemon authority.
		const snapshot = await observeRaucStage(
			{ processes: new Set(), resources: new Set() },
			deps,
		);
		// Then blank-token filtering cannot mint a missing daemon identity.
		expect(snapshot).toBeNull();
	},
);
