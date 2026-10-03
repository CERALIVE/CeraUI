import {
	sameArgv,
	splitArgv,
} from "../modules/system/update-orchestrator/os-stage-guard-kernel-rows.ts";
import { BackendSingletonError } from "./backend-singleton-error.ts";

export function parseSingletonUids(status: string): readonly number[] {
	const rows = status.split("\n").filter((row) => row.startsWith("Uid:"));
	const match =
		rows.length === 1
			? /^Uid:[\t ]+([0-9]+)[\t ]+([0-9]+)[\t ]+([0-9]+)[\t ]+([0-9]+)[\t ]*$/.exec(
					rows[0] ?? "",
				)
			: null;
	if (!match) throw new BackendSingletonError("unproven");
	const uids = match.slice(1).map(Number);
	if (uids.some((uid) => !Number.isSafeInteger(uid) || uid > 0xffffffff))
		throw new BackendSingletonError("unproven");
	return uids;
}

function exactArgv(cmdline: string, expected: readonly string[]): boolean {
	const argv = splitArgv(cmdline);
	return sameArgv(argv, expected) && cmdline === `${argv.join("\0")}\0`;
}

export async function singletonCredentialsMatch(
	proc: {
		readonly path: string;
		readonly uid: number;
		readonly argv: readonly string[];
	},
	readText: (path: string) => Promise<string>,
): Promise<boolean> {
	let status: string;
	try {
		status = await readText(`${proc.path}/status`);
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "EACCES"))
			throw cause;
		let cmdline: string;
		try {
			cmdline = await readText(`${proc.path}/cmdline`);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EACCES")
				return false;
			throw error;
		}
		if (!exactArgv(cmdline, proc.argv)) return false;
		throw new BackendSingletonError("unproven", { cause });
	}
	const [real, effective] = parseSingletonUids(status);
	if (real !== proc.uid || effective !== proc.uid) return false;
	return exactArgv(await readText(`${proc.path}/cmdline`), proc.argv);
}
