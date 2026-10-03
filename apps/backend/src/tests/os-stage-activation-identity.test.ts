import { expect, test } from "bun:test";
import {
	observeRaucStage,
	type RaucObservationDeps,
} from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { raucQuiescenceRefusal } from "../modules/system/update-orchestrator/os-stage-recovery.ts";

async function snapshot(status: string) {
	const deps: RaucObservationDeps = {
		read: async (path) => {
			if (path.endsWith("cgroup.procs")) return "659\n";
			if (path.endsWith("/stat"))
				return `659 (rauc) ${["S", ...Array(18).fill("0"), "123"].join(" ")}`;
			if (path.endsWith("mountinfo")) return "";
			throw Object.assign(new Error("absent"), { code: "ENOENT" });
		},
		list: async () => [],
		run: async (argv) => ({
			exitCode: 0,
			stderr: "",
			stdout:
				argv[0] === "systemctl"
					? "ActiveState=active\nMainPID=659\nControlGroup=/system.slice/rauc.service\n"
					: argv[0] === "busctl"
						? 's "idle"\n'
						: status,
		}),
		device: async (path) => (path.endsWith("rootfs_b") ? "179:5" : "179:4"),
		rootDevice: async () => "179:5",
		bootId: async () => "boot-B",
		healthy: async () => ({
			boot_id: "boot-B",
			slot: "B",
			build_id: "build",
			dpkg_status_sha256: "a".repeat(64),
			recorded_at: "now",
		}),
	};
	return observeRaucStage({ processes: new Set(), resources: new Set() }, deps);
}

test.each([
	["target selected", '"boot_primary":"rootfs.0"'],
	["identity missing", '"ignored_primary":"rootfs.1"'],
	["identity ambiguous", '"boot_primary":"certs.0"'],
] as const)(
	"refuses stage quiescence when bootloader %s",
	async (_name, replacement) => {
		// Given the real RAUC 1.15 JSON; change ONLY the activation identity field.
		const captured = await Bun.file(
			new URL(
				"./fixtures/rauc/status-detailed-rock-5b-plus-rauc-1.15.txt",
				import.meta.url,
			),
		).text();
		const before = await snapshot(captured);
		if (!before) throw new Error("captured baseline must be observable");
		// When slot state, devices, health and absent marker remain identical.
		const current = await snapshot(
			captured.replace('"boot_primary":"rootfs.1"', replacement),
		);
		const refusal = raucQuiescenceRefusal({
			ownership: {
				baseline: before,
				processes: new Set(before.processes),
				resources: new Set(),
			},
			current,
			cliSettled: true,
			lockHeld: true,
			requireNewInstance: false,
		});
		// Then an inactive-but-selected or unidentified target is never writable.
		expect(refusal).not.toBeNull();
	},
);

test("retains the captured bootloader identity when the healthy booted slot is selected", async () => {
	// Given the unchanged real JSON.
	const captured = await Bun.file(
		new URL(
			"./fixtures/rauc/status-detailed-rock-5b-plus-rauc-1.15.txt",
			import.meta.url,
		),
	).text();
	// When observing the slot topology.
	const current = await snapshot(captured);
	// Then boot_primary survives parsing independently of target state.
	expect(current).toHaveProperty("bootPrimary", "rootfs.1");
});
