import type { RaucStageSnapshot } from "./os-stage-recovery.ts";

export type StageProcessEvidence = {
	readonly identity: string;
	readonly membership: "cgroup" | "tracked-only";
	readonly comm: string | null;
	readonly state: string | null;
	readonly ppid: string | null;
	readonly tgid: string | null;
	readonly operation: string | null;
};
export type StageObservationEvidence = {
	readonly started: number;
	readonly finished: number;
	readonly invocationId: string | null;
	readonly mainPid: string;
	readonly members: readonly StageProcessEvidence[];
};
const evidence = new WeakMap<RaucStageSnapshot, StageObservationEvidence>();

export function rememberStageEvidence(
	snapshot: RaucStageSnapshot,
	detail: StageObservationEvidence,
): void {
	evidence.set(snapshot, detail);
}

export function stageEvidence(
	snapshot: RaucStageSnapshot | null,
): StageObservationEvidence | undefined {
	return snapshot ? evidence.get(snapshot) : undefined;
}

export function processEvidence(input: {
	readonly identity: string;
	readonly raw: string;
	readonly listed: boolean;
	readonly status: string | null;
	readonly cmdline: string | null;
}): StageProcessEvidence {
	const close = input.raw.lastIndexOf(")");
	const fields = input.raw.slice(close + 2).split(" ");
	const numeric = (value: string | undefined) =>
		value && /^[0-9]{1,20}$/.test(value) ? value : null;
	const comm = input.raw.slice(input.raw.indexOf("(") + 1, close);
	const argv = input.cmdline?.split("\0").filter(Boolean);
	const recognized = argv?.length === 3 || argv?.length === 4;
	const adapter =
		argv?.[0] === "bash" &&
		[
			"/usr/lib/rauc/ceralive-rauc-boot-adapter",
			"/usr/bin/ceralive-boot-state",
		].includes(argv?.[1] ?? "");
	const operation =
		recognized &&
		adapter &&
		((argv?.[2] === "get-primary" && argv.length === 3) ||
			(argv?.[2] === "get-state" &&
				argv.length === 4 &&
				["A", "B"].includes(argv[3] ?? "")))
			? argv.slice(2).join(" ")
			: null;
	return {
		identity: input.identity,
		membership: input.listed ? "cgroup" : "tracked-only",
		comm: /^[A-Za-z0-9_. -]{1,16}$/.test(comm) ? comm : null,
		state: /^[RSDZTWIXKP]$/.test(fields[0] ?? "") ? (fields[0] ?? null) : null,
		ppid: numeric(fields[1]),
		tgid: numeric(/^Tgid:\s*([0-9]+)\s*$/m.exec(input.status ?? "")?.[1]),
		operation,
	};
}

export async function collectStageMembers(input: {
	readonly identities: ReadonlySet<string>;
	readonly listed: readonly string[];
	readonly raw: ReadonlyMap<string, string>;
	readonly read: (path: string) => Promise<string>;
}): Promise<readonly StageProcessEvidence[]> {
	const optional = async (path: string): Promise<string | null> => {
		try {
			return await input.read(path);
		} catch {
			return null;
		}
	};
	return await Promise.all(
		[...input.identities].slice(0, 16).map(async (identity) => {
			const pid = identity.split(":")[0] ?? "";
			return processEvidence({
				identity,
				raw: input.raw.get(pid) ?? "",
				listed: input.listed.includes(pid),
				status: await optional(`/proc/${pid}/status`),
				cmdline: await optional(`/proc/${pid}/cmdline`),
			});
		}),
	);
}
