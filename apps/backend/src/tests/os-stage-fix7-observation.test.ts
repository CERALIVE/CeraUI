import { expect, test } from "bun:test";
import { observeAdmission } from "../modules/system/update-orchestrator/os-stage-admission-snapshot.ts";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { rockHelperFixture } from "./helpers/os-stage-rock-helper-fixture.ts";

test("refuses a live child created during diagnostic status collection", async () => {
	// Given real proc identity reads with synthetic RAUC/slot context.
	const fixture = rockHelperFixture([]);
	let child: ReturnType<typeof Bun.spawn> | undefined;
	const tracked = {
		processes: new Set<string>(),
		resources: new Set<string>(),
	};
	const deps = {
		...fixture.deps,
		read: async (path: string) => {
			if (path === "/proc/729106/status" && !child) {
				child = Bun.spawn(["bash", "-c", "read -r line"], {
					stdin: "pipe",
					stdout: "ignore",
					stderr: "ignore",
				});
				return "Name:\trauc\n";
			}
			if (path.endsWith("cgroup.procs") && child)
				return `729106\n${child.pid}\n`;
			if (child && path.startsWith(`/proc/${child.pid}/`))
				return Bun.file(path).text();
			return fixture.deps.read(path);
		},
	};
	try {
		// When the last observation crosses the optional diagnostic await.
		const snapshot = await observeRaucStage(tracked, deps);
		// Then it cannot authorize dispatch while that child remains alive.
		expect(child?.exitCode).toBeNull();
		await expect(observeAdmission(async () => snapshot)).rejects.toHaveProperty(
			"reason",
			"rauc_recovery_unproven",
		);
	} finally {
		if (child) {
			child.kill();
			await child.exited;
		}
	}
});

test.each(["resource", "unit"])(
	"refuses %s drift during diagnostic collection",
	async (boundary) => {
		// Given an initially quiet census that changes inside the diagnostic await.
		const fixture = rockHelperFixture([]);
		let changed = false;
		const deps = {
			...fixture.deps,
			read: async (path: string) => {
				if (path === "/proc/729106/status") changed = true;
				if (
					boundary === "resource" &&
					changed &&
					path === "/proc/self/mountinfo"
				)
					return "42 1 1:2 / /run/rauc rw - tmpfs tmpfs rw\n";
				return fixture.deps.read(path);
			},
			run: async (...args: Parameters<typeof fixture.deps.run>) => {
				const result = await fixture.deps.run(...args);
				return boundary === "unit" && changed && args[0][0] === "systemctl"
					? { ...result, stdout: result.stdout.replace("active", "inactive") }
					: result;
			},
		};
		// When final observation completes after the changed evidence.
		const snapshot = await observeRaucStage(
			{ processes: new Set(), resources: new Set() },
			deps,
		);
		// Then stale safety evidence is rejected rather than returned.
		expect(snapshot).toBeNull();
	},
);
