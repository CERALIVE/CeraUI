// Attempt-owned block devices and mounts for one RAUC observation. Split from
// the observer so every probe argv stays in `observeRaucStage` (exec guard).
import type { RaucObservationDeps } from "./os-stage-observation.ts";

export type ObservationResourceInput = {
	readonly deps: RaucObservationDeps;
	readonly tracked: { readonly resources: ReadonlySet<string> };
	readonly group: string;
	readonly processIds: ReadonlySet<string>;
	readonly readProcess: (pid: string) => Promise<string | null>;
	/** Labels the boundary about to be crossed, for the caller's diagnostics. */
	readonly at: (stage: string) => void;
};

function absent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Null means ownership is unproven at the stage last passed to `at`. */
export async function observeStageResources(
	input: ObservationResourceInput,
): Promise<Set<string> | null> {
	const { deps, tracked, group, processIds } = input;
	const resources = new Set<string>();
	input.at("block-inventory");
	const blocks = await deps.list("/sys/block");
	const ownedNbd = new Set<string>();
	const foreignNbd = new Set<string>();
	for (const name of blocks.filter((name) => /^nbd[0-9]+$/.test(name))) {
		input.at("nbd-pid");
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
		input.at("nbd-process");
		const identity = await input.readProcess(nbdPid);
		if (!identity) return null;
		const id = `nbd:${name}:${identity}`;
		input.at("nbd-cgroup");
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
		input.at("dm-identity");
		const dev = (await deps.read(`/sys/block/${name}/dev`)).trim();
		const uuid = (await deps.read(`/sys/block/${name}/dm/uuid`)).trim();
		const id = `dm:${dev}:${uuid}`;
		input.at("dm-slaves");
		const slaves = await deps.list(`/sys/block/${name}/slaves`);
		if (
			slaves.some((name) => ownedNbd.has(name)) ||
			tracked.resources.has(id)
		) {
			input.at("dm-identity");
			if (!uuid) return null;
			ownedDevices.add(dev);
			resources.add(id);
		} else if (
			slaves.some((name) => /^nbd[0-9]+$/.test(name) && !foreignNbd.has(name))
		)
			resources.add(`unowned-${id}`);
	}
	input.at("mountinfo");
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
	return resources;
}
