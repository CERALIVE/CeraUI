import { expect, test } from "bun:test";
import { describeObservationFailure } from "../modules/system/update-orchestrator/os-stage-admission-diagnostics.ts";
import { readStageProcess } from "../modules/system/update-orchestrator/os-stage-census.ts";
import { osInstallClientsGone } from "../modules/system/update-orchestrator/os-stage-install-clients.ts";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { collectStageMembers } from "../modules/system/update-orchestrator/os-stage-process-evidence.ts";
import { createRecoveryProbes } from "../modules/system/update-orchestrator/recovery-probes.ts";
import {
	rockHelperFixture,
	rockStats,
} from "./helpers/os-stage-rock-helper-fixture.ts";

const errnos = ["ENOENT", "ESRCH", "EACCES", "EPERM", "EIO", "ENOMEM"];
const gone = (code: string) => code === "ENOENT" || code === "ESRCH";

test.each(errnos)(
	"listed helper %s preserves absence versus unknown",
	async (code) => {
		// Given both cached ownership and a listed helper with a failed stat read.
		const fixture = rockHelperFixture(["877184"]);
		fixture.showHelpers();
		const fault = Object.assign(new Error("credential text"), { code });
		const deps = {
			...fixture.deps,
			read: async (path: string) => {
				if (path === "/proc/877184/stat") throw fault;
				return fixture.deps.read(path);
			},
		};
		// When production observes both fresh censuses.
		const snapshot = await observeRaucStage(
			{ processes: new Set(["877184:2852694"]), resources: new Set() },
			deps,
		);
		// Then only positive disappearance can exclude the previously tracked member.
		if (gone(code)) expect(snapshot?.processes).toEqual(["729106:2374530"]);
		else expect(snapshot).toBeNull();
	},
);

test.each(errnos)(
	"install-client cmdline %s preserves absence versus unknown",
	async (code) => {
		// Given a previously enumerated client whose read fails.
		const fault = Object.assign(new Error("x"), { code });
		// When checking the actual install-client exclusion port.
		const result = await osInstallClientsGone(undefined, {
			list: async () => ["877184"],
			read: async () => {
				throw fault;
			},
		});
		// Then only ENOENT/ESRCH proves that client gone.
		expect(result).toBe(gone(code));
	},
);

test.each(errnos)(
	"recovery comm %s preserves absence versus unknown",
	async (code) => {
		// Given a previously enumerated process and quiet independent unit/RAUC ports.
		const fault = Object.assign(new Error("x"), { code });
		const probes = createRecoveryProbes({
			list: async () => ["877184"],
			read: async () => {
				throw fault;
			},
			run: async (argv) => ({
				code: 0,
				stdout: argv[0] === "busctl" ? 's "idle"' : "ActiveState=inactive",
			}),
		});
		// When inspecting recovery's real process read.
		const result = probes.operationsIdle();
		// Then all non-disappearance errnos remain unreadable.
		if (gone(code)) expect(await result).toBe(true);
		else await expect(result).rejects.toBe(fault);
	},
);

test.each(["/proc/877184/stat", "/proc/877184/cgroup"])(
	"configured NBD %s cannot vanish with its creator",
	async (path) => {
		// Given a configured block device with no previously proven connection owner.
		const fixture = rockHelperFixture(["877184"]);
		fixture.showHelpers();
		const deps = {
			...fixture.deps,
			list: async () => ["nbd43"],
			read: async (current: string) => {
				if (current === path)
					throw Object.assign(new Error("x"), { code: "ESRCH" });
				if (current === "/sys/block/nbd43/pid") return "877184";
				return fixture.deps.read(current);
			},
		};
		// When the creator dies, configured-resource ownership is still unproven.
		const result = await observeRaucStage(
			{ processes: new Set(), resources: new Set() },
			deps,
		);
		// Then no snapshot authorizes action based on presumed device retirement.
		expect(result).toBeNull();
	},
);

test.each([
	"/sys/fs/cgroup/system.slice/rauc.service/cgroup.procs",
	"/data/ceralive/update-state/activation-armed",
	"/sys/block/nbd43/pid",
])("non-process ESRCH at %s stays unknown", async (path) => {
	// Given a filesystem boundary, not a vanished enumerated process.
	const fixture = rockHelperFixture([]);
	const deps = {
		...fixture.deps,
		list: async () => (path.includes("nbd") ? ["nbd43"] : []),
		read: async (current: string) => {
			if (current === path)
				throw Object.assign(new Error("secret"), { code: "ESRCH" });
			return fixture.deps.read(current);
		},
		activationArmed: async () => {
			if (path.endsWith("/activation-armed"))
				throw Object.assign(new Error("secret"), { code: "ESRCH" });
			return false;
		},
	};
	// When the observer sees ESRCH outside /proc/<pid>.
	const result = await observeRaucStage(
		{ processes: new Set(), resources: new Set() },
		deps,
	);
	// Then scope prevents broadening filesystem absence.
	expect(result).toBeNull();
});

test.each(["", "877184 (bash) S 729106", "malformed"])(
	"successful malformed stat %j stays unknown",
	async (raw) => {
		// Given a successful but incomplete identity read, not an errno.
		const fixture = rockHelperFixture([]);
		// When the real census identity parser sees that content.
		const result = readStageProcess("877184", {
			...fixture.deps,
			read: async () => raw,
		});
		// Then it must not fabricate disappearance or cached identity.
		await expect(result).rejects.toThrow("process identity unreadable");
	},
);

test.each(["status", "cmdline"])(
	"optional ESRCH %s diagnostics are unavailable, never authority",
	async (file) => {
		// Given existing identity evidence and an optional diagnostic read that fails.
		const raw = rockStats.get("877184");
		if (!raw) throw new Error("missing fixture");
		// When collecting non-authorizing metadata.
		const members = await collectStageMembers({
			identities: new Set(["877184:2852694"]),
			listed: ["877184"],
			raw: new Map([["877184", raw]]),
			read: async (path) => {
				if (path.endsWith(`/${file}`))
					throw Object.assign(new Error("x"), { code: "ESRCH" });
				return "";
			},
		});
		// Then absent diagnostics invent neither an operation nor thread identity.
		expect(members[0]?.tgid).toBeNull();
		expect(members[0]?.operation).toBeNull();
	},
);

test("terminal ESRCH diagnostics name only bounded errno and class", () => {
	// Given an ESRCH with arbitrary private message text.
	const error = Object.assign(new Error("credential text"), { code: "ESRCH" });
	// When rendering a future failure on a non-process boundary.
	const detail = describeObservationFailure("cgroup-processes", error);
	// Then operators get the code without message disclosure.
	expect(detail).toBe("cgroup-processes: Error(ESRCH):");
});
