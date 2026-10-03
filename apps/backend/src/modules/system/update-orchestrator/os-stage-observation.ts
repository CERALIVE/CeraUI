import { readdir, stat } from "node:fs/promises";
import { z } from "zod";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { readBootId } from "./os-identity.ts";
import type { RaucStageSnapshot } from "./os-stage-recovery.ts";
import { parseOsStageSystemdProperties } from "./os-stage-systemd.ts";
import { readHealthyState } from "./slot-sync-state.ts";

const slotsSchema = z.object({
	boot_primary: z.string().nullish(),
	slots: z.array(
		z.record(
			z.string(),
			z.object({
				class: z.string(),
				state: z.string(),
				device: z.string(),
				bootname: z.string().nullish(),
				boot_status: z.string().nullish(),
			}),
		),
	),
});

export type RaucObservationDeps = {
	readonly read: (path: string) => Promise<string>;
	readonly list: (path: string) => Promise<string[]>;
	readonly run: typeof spawnWithTimeout;
	readonly device: (path: string) => Promise<string>;
	readonly rootDevice: () => Promise<string>;
	readonly bootId: () => Promise<string>;
	readonly healthy: typeof readHealthyState;
};
const defaults: RaucObservationDeps = {
	read: (path) => Bun.file(path).text(),
	list: readdir,
	run: spawnWithTimeout,
	device: async (path) => String((await stat(path)).rdev),
	rootDevice: async () => String((await stat("/")).dev),
	bootId: readBootId,
	healthy: readHealthyState,
};

function absent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function processIdentity(pid: string, raw: string): string {
	const tail = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
	const ticks = tail[19];
	if (!/^[1-9][0-9]*$/.test(pid) || !ticks || !/^[0-9]+$/.test(ticks))
		throw new Error("process identity unreadable");
	return `${pid}:${ticks}`;
}

async function readProcess(
	pid: string,
	deps: RaucObservationDeps,
): Promise<string | null> {
	try {
		return processIdentity(pid, await deps.read(`/proc/${pid}/stat`));
	} catch (error) {
		if (absent(error)) return null;
		throw error;
	}
}

export async function observeRaucStage(
	tracked: {
		readonly processes: ReadonlySet<string>;
		readonly resources: ReadonlySet<string>;
	},
	deps: RaucObservationDeps = defaults,
): Promise<RaucStageSnapshot | null> {
	try {
		const service = await deps.run(
			[
				"systemctl",
				"show",
				"rauc.service",
				"--property=ActiveState,MainPID,ControlGroup",
			],
			{ timeoutMs: 2_000 },
		);
		const properties = parseOsStageSystemdProperties(service.stdout);
		if (!properties) return null;
		const group = properties.get("ControlGroup");
		const pid = properties.get("MainPID") ?? "";
		if (
			service.exitCode !== 0 ||
			!group ||
			!/^\/system.slice\/rauc.service$/.test(group)
		)
			return null;
		const instance = await readProcess(pid, deps);
		if (!instance) return null;
		const pids = (await deps.read(`/sys/fs/cgroup${group}/cgroup.procs`))
			.trim()
			.split(/\s+/);
		const processIds = new Set<string>();
		for (const currentPid of new Set([
			...pids,
			...[...tracked.processes].map((id) => id.split(":")[0] ?? ""),
		])) {
			const identity = await readProcess(currentPid, deps);
			if (
				identity &&
				(pids.includes(currentPid) || tracked.processes.has(identity))
			)
				processIds.add(identity);
		}
		const resources = new Set<string>();
		const blocks = await deps.list("/sys/block");
		const ownedNbd = new Set<string>();
		const foreignNbd = new Set<string>();
		for (const name of blocks.filter((name) => /^nbd[0-9]+$/.test(name))) {
			let nbdPid: string;
			try {
				nbdPid = (await deps.read(`/sys/block/${name}/pid`)).trim();
			} catch (error) {
				if (absent(error)) continue;
				throw error;
			}
			// Sysfs caches a numeric creator PID, not a connection generation. A
			// recycled proc identity cannot prove a previously owned device retired.
			const priorConnections = [...tracked.resources].filter((id) =>
				id.startsWith(`nbd:${name}:`),
			);
			if (priorConnections.length) {
				ownedNbd.add(name);
				for (const id of priorConnections) resources.add(id);
				continue;
			}
			const identity = await readProcess(nbdPid, deps);
			if (!identity) return null;
			const id = `nbd:${name}:${identity}`;
			const cgroup = await deps.read(`/proc/${nbdPid}/cgroup`);
			if (!/^0::\/[^\n]*\n?$/.test(cgroup)) return null;
			if (
				cgroup.trim() === `0::${group}` ||
				processIds.has(identity) ||
				tracked.resources.has(id)
			) {
				ownedNbd.add(name);
				resources.add(id);
			} else foreignNbd.add(name);
		}
		const ownedDevices = new Set<string>();
		for (const name of blocks.filter((name) => /^dm-[0-9]+$/.test(name))) {
			const dev = (await deps.read(`/sys/block/${name}/dev`)).trim();
			const uuid = (await deps.read(`/sys/block/${name}/dm/uuid`)).trim();
			const id = `dm:${dev}:${uuid}`;
			const slaves = await deps.list(`/sys/block/${name}/slaves`);
			if (
				slaves.some((name) => ownedNbd.has(name)) ||
				tracked.resources.has(id)
			) {
				if (!uuid) return null;
				ownedDevices.add(dev);
				resources.add(id);
			} else if (
				slaves.some((name) => /^nbd[0-9]+$/.test(name) && !foreignNbd.has(name))
			)
				resources.add(`unowned-${id}`);
		}
		for (const line of (await deps.read("/proc/self/mountinfo"))
			.trim()
			.split("\n")) {
			const fields = line.split(" ");
			const point = fields[4] ?? "";
			const id = `mount:${fields[0]}:${fields[2]}:${point}`;
			if (
				point === "/run/rauc" ||
				point.startsWith("/run/rauc/") ||
				ownedDevices.has(fields[2] ?? "") ||
				tracked.resources.has(id)
			)
				resources.add(id);
		}
		const operation = await deps.run(
			[
				"busctl",
				"get-property",
				"de.pengutronix.rauc",
				"/",
				"de.pengutronix.rauc.Installer",
				"Operation",
			],
			{ timeoutMs: 2_000 },
		);
		const status = await deps.run(
			["rauc", "status", "--detailed", "--output-format=json"],
			{ timeoutMs: 2_000 },
		);
		if (status.exitCode !== 0) return null;
		const parsed = slotsSchema.parse(JSON.parse(status.stdout));
		const rootfs = parsed.slots
			.flatMap((row) => Object.entries(row))
			.filter(([, slot]) => slot.class === "rootfs");
		const booted = rootfs.filter(([, slot]) => slot.state === "booted");
		const target = rootfs.filter(([, slot]) => slot.state === "inactive");
		if (rootfs.length !== 2 || booted.length !== 1 || target.length !== 1)
			return null;
		const boot = booted[0];
		const other = target[0];
		if (!boot || !other) return null;
		const bootId = await deps.bootId();
		const healthy = await deps.healthy();
		const bootedDevice = await deps.device(boot[1].device);
		const rootDevice = await deps.rootDevice();
		let activationArmed = true;
		try {
			await deps.read("/data/ceralive/update-state/activation-armed");
		} catch (error) {
			if (!absent(error)) throw error;
			activationArmed = false;
		}
		return {
			instance,
			active: properties.get("ActiveState") === "active",
			operation:
				operation.exitCode === 0
					? (/^s "([^"\n]+)"\s*$/.exec(operation.stdout)?.[1] ?? null)
					: null,
			processes: [...processIds],
			resources: [...resources],
			bootId,
			bootPrimary:
				rootfs.filter(([name]) => name === parsed.boot_primary).length === 1
					? (parsed.boot_primary ?? null)
					: null,
			bootedSlot: boot[0],
			bootedDevice,
			bootedHealthy:
				bootedDevice === rootDevice &&
				boot[1].boot_status === "good" &&
				healthy?.boot_id === bootId &&
				(healthy.slot === boot[0] || healthy.slot === boot[1].bootname),
			targetSlot: other[0],
			targetDevice: await deps.device(other[1].device),
			targetInactive: other[1].state === "inactive",
			activationArmed,
		};
	} catch {
		// Observation failure never authorizes cancellation, cleanup or another writer.
		return null;
	}
}
