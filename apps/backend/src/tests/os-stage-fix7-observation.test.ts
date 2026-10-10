import { expect, test } from "bun:test";
import { spawnWithTimeout } from "../helpers/spawn-policy.ts";
import { observeAdmission } from "../modules/system/update-orchestrator/os-stage-admission-snapshot.ts";
import { beginOsStageAttempt } from "../modules/system/update-orchestrator/os-stage-attempt.ts";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { rockHelperFixture } from "./helpers/os-stage-rock-helper-fixture.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

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

test("runner refuses a replacement when a live child appears inside its final diagnostic await", async () => {
	// Given a real failed CLI with synthetic RAUC/slot ports and real live child proc reads.
	const h = await harness();
	const fixture = rockHelperFixture([]);
	let child: ReturnType<typeof Bun.spawn> | undefined;
	let restarted = false;
	let revalidations = 0;
	let replacementSamples = 0;
	let dispatches = 0;
	const deps = {
		...fixture.deps,
		read: async (path: string) => {
			if (
				path === "/proc/729106/status" &&
				revalidations === 2 &&
				++replacementSamples === 2
			) {
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
			const raw = await fixture.deps.read(path);
			return restarted && path === "/proc/729106/stat"
				? raw.replace("2374530", "2374531")
				: raw;
		},
	};
	try {
		// When the runner takes the final replacement observation after revalidation.
		await expect(
			runOsStageJob(manifest, h.control, {
				...h.deps,
				revalidate: async () => {
					revalidations++;
				},
				restart: async () => {
					restarted = true;
				},
				observe: (tracked, _deps, report) =>
					observeRaucStage(tracked, deps, report),
				attempt: (input) =>
					beginOsStageAttempt(input, {
						run: (_argv, options) => {
							dispatches++;
							return spawnWithTimeout(["false"], options);
						},
						topology: async () => ({ kind: "lost", reason: "admin-down" }),
						https: async () => ({ kind: "unavailable" }),
						every: (ms, action) => {
							if (ms === 3_000) queueMicrotask(action);
							return () => {};
						},
					}),
			}),
		).rejects.toHaveProperty("mode", "unsafe");
		// Then only the original writer ran, with the introduced child still alive.
		expect(dispatches).toBe(1);
		expect(child?.exitCode).toBeNull();
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
