import { z } from "zod";
import type { RaucObservationDeps } from "../../modules/system/update-orchestrator/os-stage-observation.ts";

const recorded = z
	.object({
		reads: z.record(z.string(), z.string()),
		lists: z.record(z.string(), z.array(z.string())),
		commands: z.record(
			z.string(),
			z.object({
				exitCode: z.number(),
				stdout: z.string(),
				stderr: z.string(),
			}),
		),
		devices: z.record(z.string(), z.string()),
		rootDevice: z.string(),
		bootId: z.uuid(),
		healthy: z.object({
			boot_id: z.string(),
			slot: z.string(),
			build_id: z.string(),
			dpkg_status_sha256: z.string(),
			recorded_at: z.string(),
		}),
		absent: z.array(z.string()),
	})
	.parse(
		await Bun.file(
			new URL(
				"../fixtures/real-device/rock-admission-20261009.json",
				import.meta.url,
			),
		).json(),
	);

export const recordedAdmissionDeps: RaucObservationDeps = {
	read: async (path) => {
		if (recorded.absent.includes(path))
			throw Object.assign(new Error("absent"), { code: "ENOENT" });
		const value = recorded.reads[path];
		if (value === undefined) throw new Error(`Uncaptured read: ${path}`);
		return value;
	},
	list: async (path) => {
		const value = recorded.lists[path];
		if (value === undefined) throw new Error(`Uncaptured list: ${path}`);
		return value;
	},
	run: async (argv) => {
		// The historical command did not request InvocationID; keep it UNKNOWN.
		const key = argv
			.map((arg) =>
				arg === "--property=ActiveState,MainPID,ControlGroup,InvocationID"
					? "--property=ActiveState,MainPID,ControlGroup"
					: arg,
			)
			.join(" ");
		const value = recorded.commands[key];
		if (value === undefined) throw new Error("Uncaptured command");
		return value;
	},
	device: async (path) => {
		const value = recorded.devices[path];
		if (value === undefined) throw new Error(`Uncaptured device: ${path}`);
		return value;
	},
	rootDevice: async () => recorded.rootDevice,
	bootId: async () => recorded.bootId,
	healthy: async () => recorded.healthy,
};
