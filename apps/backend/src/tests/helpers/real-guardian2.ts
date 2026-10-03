import { SOFTWARE_UPDATE_LOCK } from "../../modules/system/update-orchestrator/lock.ts";
import type {
	Identity,
	KernelLockIdentity,
} from "../../modules/system/update-orchestrator/os-stage-guard-kernel-rows.ts";
import type { OsGuardKernelDeps } from "../../modules/system/update-orchestrator/os-stage-guard-lock.ts";
import {
	OS_STAGE_GUARD_HELPER,
	OS_STAGE_GUARD_UNIT,
} from "../../modules/system/update-orchestrator/os-stage-job-files.ts";
import { kernelDeviceFromMount } from "../../modules/system/update-orchestrator/os-stage-lock-device.ts";
import { realDeviceReply, realDeviceSection } from "./real-device-fixture.ts";

export const guardian2Token = "33333333-3333-4333-8333-333333333333";
export const guardian2KilledToken = "44444444-4444-4444-8444-444444444444";

// Alias isolated identity only, never lifecycle, fd metadata or process grammar.
export function guardian2ProductIdentity(output: string): string {
	return output
		.replaceAll("uso-fixture-guard2.service", OS_STAGE_GUARD_UNIT)
		.replaceAll(
			"Description=uso fixture guard 2",
			"Description=CeraLive OS stage lock",
		)
		.replaceAll("/run/uso-fixture2.lock", SOFTWARE_UPDATE_LOCK)
		.replaceAll("/run/uso-fixture-guard2/helper", OS_STAGE_GUARD_HELPER);
}

export async function guardian2Section(section: string): Promise<string> {
	return realDeviceSection("rock-guardian2", section);
}

function statIdentity(output: string): Identity {
	const [, dev, ino] = output.trim().split(" ");
	if (!dev || !ino || !/^\d+$/.test(dev) || !/^\d+$/.test(ino))
		throw new Error("Invalid captured stat identity");
	return { dev: Number(dev), ino: Number(ino) };
}

export async function guardian2Lock(): Promise<KernelLockIdentity> {
	const identity = statIdentity(await guardian2Section("lock-stat"));
	const device = kernelDeviceFromMount(
		await guardian2Section("running-1640654-fdinfo-3"),
		await guardian2Section("mountinfo"),
		identity.ino,
	);
	if (!device) throw new Error("Invalid captured lock mount identity");
	return { ...identity, device };
}

/** Replays only the three captured unit members, not a whole-system fd inventory. */
export async function guardian2Kernel(
	stage: "running" | "exited",
): Promise<OsGuardKernelDeps> {
	const reads = new Map<string, string>();
	const identities = new Map<string, Identity>();
	const lists = new Map<string, string[]>();
	const lock = await guardian2Lock();
	identities.set(SOFTWARE_UPDATE_LOCK, lock);
	reads.set(
		"/proc/locks",
		await guardian2Section(stage === "running" ? "locks" : "exited-locks"),
	);
	const group = `/sys/fs/cgroup/system.slice/${OS_STAGE_GUARD_UNIT}/cgroup.procs`;
	const members =
		stage === "running"
			? (await guardian2Section("running-procs")).trim().split(/\s+/)
			: [];
	lists.set("/proc", members);
	if (stage === "running")
		reads.set(group, await guardian2Section("running-procs"));
	for (const pid of members) {
		for (const file of ["stat", "cgroup", "cmdline"] as const) {
			const raw = await guardian2Section(`running-${pid}-${file}`);
			reads.set(
				`/proc/${pid}/${file}`,
				guardian2ProductIdentity(
					file === "cmdline"
						? Buffer.from(raw.trim(), "base64").toString()
						: raw,
				),
			);
		}
		const fds = (await guardian2Section(`running-${pid}-fds`))
			.split("\n")
			.map((line) => line.match(/ (\d+) -> /)?.[1])
			.filter((fd): fd is string => fd !== undefined);
		lists.set(`/proc/${pid}/fd`, fds);
		for (const fd of fds) {
			const identity = statIdentity(
				await guardian2Section(`running-${pid}-fd-${fd}-stat`),
			);
			identities.set(`/proc/${pid}/fd/${fd}`, identity);
			if (identity.ino === lock.ino && identity.dev === lock.dev)
				reads.set(
					`/proc/${pid}/fdinfo/${fd}`,
					await guardian2Section(`running-${pid}-fdinfo-${fd}`),
				);
		}
	}
	const missing = (path: string) =>
		Object.assign(new Error(`Uncaptured or retired path: ${path}`), {
			code: "ENOENT",
		});
	return {
		lock: SOFTWARE_UPDATE_LOCK,
		device: async () => lock.device,
		read: async (path) => {
			const value = reads.get(path);
			if (value === undefined) {
				const absent = await realDeviceReply(
					"rock-guardian2",
					"ack-0001-procs",
				);
				if (
					stage === "exited" &&
					path === group &&
					absent.exitCode !== 0 &&
					absent.stderr.includes("No such file or directory")
				)
					throw missing(path);
				throw new Error(`Missing real read: ${path}`);
			}
			return value;
		},
		list: async (path) => {
			const value = lists.get(path);
			if (!value) throw missing(path);
			return value;
		},
		identity: async (path) => {
			const value = identities.get(path);
			if (!value) throw missing(path);
			return value;
		},
	};
}
