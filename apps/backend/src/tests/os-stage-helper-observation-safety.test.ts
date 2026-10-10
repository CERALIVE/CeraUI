import { expect, test } from "bun:test";
import { observeAdmission } from "../modules/system/update-orchestrator/os-stage-admission-snapshot.ts";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { stageEvidence } from "../modules/system/update-orchestrator/os-stage-process-evidence.ts";
import { rockHelperFixture } from "./helpers/os-stage-rock-helper-fixture.ts";

test.each(["cgroup-listed", "escaped-but-tracked"])(
	"persistent real-stat %s member cannot authorize admission",
	async (membership) => {
		// Given the captured bash identity is still alive, inside or outside the current cgroup.
		const fixture = rockHelperFixture(["877184"]);
		fixture.showHelpers();
		const tracked = {
			processes: new Set(["877184:2852694"]),
			resources: new Set<string>(),
		};
		const deps = {
			...fixture.deps,
			read: async (path: string) =>
				path.endsWith("cgroup.procs") && membership === "escaped-but-tracked"
					? "729106\n"
					: fixture.deps.read(path),
		};
		let now = 0;
		let snapshot = await observeRaucStage(tracked, deps);
		// When bounded admission repeatedly observes that exact retained identity.
		await expect(
			observeAdmission(
				async () => {
					snapshot = await observeRaucStage(tracked, deps);
					return snapshot;
				},
				undefined,
				{
					now: () => now,
					sleep: async (ms) => {
						now += ms;
					},
					deadline: 200,
					assert: async () => {},
				},
			),
		).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
		// Then cgroup escape never makes the tracked writer disappear from proof.
		expect(snapshot?.processes).toContain("877184:2852694");
		expect(
			stageEvidence(snapshot)?.members.find(
				(member) => member.identity === "877184:2852694",
			)?.membership,
		).toBe(membership === "cgroup-listed" ? "cgroup" : "tracked-only");
	},
);

test("PID reuse of a listed helper remains an extra process rather than an old-identity exemption", async () => {
	// Given ownership names older ticks than the captured PID's actual current stat.
	const fixture = rockHelperFixture(["877184"]);
	fixture.showHelpers();
	const tracked = {
		processes: new Set(["877184:100"]),
		resources: new Set<string>(),
	};
	// When the production observer reads the listed recycled PID.
	const snapshot = await observeRaucStage(tracked, fixture.deps);
	// Then it reports the new identity and strict admission still refuses.
	expect(snapshot?.processes).toContain("877184:2852694");
	expect(snapshot?.processes).not.toContain("877184:100");
	await expect(observeAdmission(async () => snapshot)).rejects.toHaveProperty(
		"reason",
		"rauc_recovery_unproven",
	);
});

test("configured NBD with a stale creator retains its recorded resource across PID reuse", async () => {
	// Given a configured device still exports the reused numeric creator PID.
	const fixture = rockHelperFixture([]);
	const resource = "nbd:nbd43:877184:100";
	const tracked = {
		processes: new Set<string>(),
		resources: new Set([resource]),
	};
	const deps = {
		...fixture.deps,
		list: async () => ["nbd43"],
		read: async (path: string) =>
			path === "/sys/block/nbd43/pid" ? "877184\n" : fixture.deps.read(path),
	};
	// When production observation and admission inspect that retained connection.
	const snapshot = await observeRaucStage(tracked, deps);
	await expect(observeAdmission(async () => snapshot)).rejects.toHaveProperty(
		"reason",
		"rauc_recovery_unproven",
	);
	// Then stale process ownership cannot certify block retirement.
	expect(snapshot?.resources).toContain(resource);
});

test("helper stat EACCES cannot be converted into an absent member", async () => {
	// Given a listed member whose identity cannot be read.
	const fixture = rockHelperFixture(["877184"]);
	fixture.showHelpers();
	const deps = {
		...fixture.deps,
		read: async (path: string) => {
			if (path === "/proc/877184/stat")
				throw Object.assign(new Error("private credential text"), {
					code: "EACCES",
				});
			return fixture.deps.read(path);
		},
	};
	let detail = "";
	// When the identity read fails, not merely returns ENOENT.
	const snapshot = await observeRaucStage(
		{ processes: new Set(), resources: new Set() },
		deps,
		(value) => {
			detail = value;
		},
	);
	// Then no snapshot exists and diagnostics retain only the bounded class/code.
	expect(snapshot).toBeNull();
	expect(detail).toBe("cgroup-processes: Error(EACCES):");
});

test("positive helper ENOENT does not invent an identity or keep a cached earlier member", async () => {
	// Given a helper PID disappeared between cgroup enumeration and stat reading.
	const fixture = rockHelperFixture(["877184"]);
	fixture.showHelpers();
	const deps = {
		...fixture.deps,
		read: async (path: string) => {
			if (path === "/proc/877184/stat")
				throw Object.assign(new Error("gone"), { code: "ENOENT" });
			return fixture.deps.read(path);
		},
	};
	// When production observation applies its existing positive-absence rule.
	const snapshot = await observeRaucStage(
		{ processes: new Set(["877184:2852694"]), resources: new Set() },
		deps,
	);
	// Then only the freshly read daemon identity is present; no helper identity is fabricated.
	expect(snapshot?.processes).toEqual(["729106:2374530"]);
	expect(stageEvidence(snapshot)?.members).toHaveLength(1);
});
