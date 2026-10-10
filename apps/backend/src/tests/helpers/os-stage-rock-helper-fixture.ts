import type { RaucObservationDeps } from "../../modules/system/update-orchestrator/os-stage-observation.ts";

// Passive Rock capture 2026-10-10, cgroup.stdout:448,452,456,1803.
// These are NOT the unknown historical 09:53:13 veto identities.
export const rockStats = new Map([
	[
		"729106",
		"729106 (rauc) S 1 729106 729106 0 -1 4194560 265888 6122060 0 51 368 517 6122 4998 20 0 5 0 2374530 338096128 3948 18446744073709551615 1 1 0 0 0 0 0 4096 16384 0 0 0 17 6 0 0 0 0 0 0 0 0 0 0 0 0 0",
	],
	[
		"877184",
		"877184 (bash) S 729106 729106 729106 0 -1 4194304 298 68 0 0 0 0 0 0 20 0 1 0 2852694 4583424 780 18446744073709551615 1 1 0 0 0 0 65536 4 65538 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
	],
	[
		"877186",
		"877186 (bash) S 877184 729106 729106 0 -1 4194304 377 327 0 0 1 0 0 0 20 0 1 0 2852695 4718592 827 18446744073709551615 1 1 0 0 0 0 2 4 65536 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
	],
	[
		"878794",
		"878794 (bash) R 729106 729106 729106 0 -1 4194304 254 0 0 0 0 0 0 0 20 0 1 0 2853697 4583424 796 18446744073709551615 1 1 0 0 0 0 2147221247 4 65536 0 0 0 17 1 0 0 0 0 0 0 0 0 0 0 0 0 0",
	],
]);

export function rockHelperFixture(helperPids: readonly string[]) {
	let extras = false;
	const deps: RaucObservationDeps = {
		read: async (path) => {
			if (path.endsWith("cgroup.procs"))
				return ["729106", ...(extras ? helperPids : [])].join("\n");
			if (path === "/proc/self/mountinfo") return "";
			const pid = /^\/proc\/(\d+)\/stat$/.exec(path)?.[1];
			const raw =
				pid && (pid === "729106" || extras) ? rockStats.get(pid) : undefined;
			if (raw) return raw;
			throw Object.assign(new Error("fixture absent"), { code: "ENOENT" });
		},
		list: async () => [],
		run: async (argv) => ({
			exitCode: 0,
			stderr: "",
			stdout:
				argv[0] === "systemctl"
					? "ActiveState=active\nMainPID=729106\nControlGroup=/system.slice/rauc.service\n"
					: argv[0] === "busctl"
						? 's "idle"\n'
						: JSON.stringify({
								boot_primary: "rootfs.1",
								slots: [
									{
										"rootfs.1": {
											class: "rootfs",
											state: "booted",
											device: "/dev/b",
											boot_status: "good",
											bootname: "B",
										},
									},
									{
										"rootfs.0": {
											class: "rootfs",
											state: "inactive",
											device: "/dev/a",
											boot_status: "bad",
											bootname: "A",
										},
									},
								],
							}),
		}),
		// Slot, resource and health context is SYNTHETIC, not a full R14 replay.
		device: async (path) => (path === "/dev/b" ? "179:5" : "179:4"),
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
	return {
		deps,
		showHelpers: () => {
			extras = true;
		},
		retireHelpers: () => {
			extras = false;
		},
	};
}
