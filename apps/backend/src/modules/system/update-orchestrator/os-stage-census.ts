import {
	processIdentity,
	type RaucObservationDeps,
} from "./os-stage-observation.ts";
import { observeStageResources } from "./os-stage-observation-resources.ts";

export async function readStageProcess(
	pid: string,
	deps: RaucObservationDeps,
	raw?: Map<string, string>,
): Promise<string | null> {
	try {
		const value = await deps.read(`/proc/${pid}/stat`);
		raw?.set(pid, value);
		return processIdentity(pid, value);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
}

export async function observeStageCensus(input: {
	readonly deps: RaucObservationDeps;
	readonly tracked: {
		readonly processes: ReadonlySet<string>;
		readonly resources: ReadonlySet<string>;
	};
	readonly group: string;
	readonly raw?: Map<string, string>;
	readonly at: (stage: string) => void;
}) {
	const { deps, tracked, group, at } = input;
	at("cgroup-processes");
	const pids = (await deps.read(`/sys/fs/cgroup${group}/cgroup.procs`))
		.trim()
		.split(/\s+/);
	const processIds = new Set<string>();
	for (const pid of new Set([
		...pids,
		...[...tracked.processes].map((id) => id.split(":")[0] ?? ""),
	])) {
		const identity = await readStageProcess(pid, deps, input.raw);
		if (identity && (pids.includes(pid) || tracked.processes.has(identity)))
			processIds.add(identity);
	}
	const resources = await observeStageResources({
		deps,
		tracked,
		group,
		processIds,
		readProcess: (pid) => readStageProcess(pid, deps),
		at,
	});
	return resources ? { pids, processIds, resources } : null;
}

export function sameStageSet(
	left: ReadonlySet<string>,
	right: ReadonlySet<string>,
): boolean {
	return left.size === right.size && [...left].every((id) => right.has(id));
}
