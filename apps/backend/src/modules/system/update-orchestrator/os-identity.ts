import { z } from "zod";

const RAUC_CONFIG = "/etc/rauc/system.conf";
const BOOT_ID = "/proc/sys/kernel/random/boot_id";

export class OsAgentError extends Error {
	override readonly name = "OsAgentError";
	constructor(
		readonly reason: string,
		cause?: unknown,
	) {
		super(reason, { cause });
	}
}

export async function readBootId(): Promise<string> {
	const id = (await Bun.file(BOOT_ID).text()).trim();
	if (!z.uuid().safeParse(id).success)
		throw new OsAgentError("boot_id_unknown");
	return id;
}

export async function readBoardIdentity(path = RAUC_CONFIG): Promise<{
	readonly board: string;
	readonly compatible: string;
}> {
	const conf = await Bun.file(path).text();
	const section = conf.split(/^\[system\]\s*$/m)[1]?.split(/^\[.*\]\s*$/m)[0];
	const matches = section?.match(/^compatible\s*=\s*(\S+)\s*$/gm) ?? [];
	if (matches.length !== 1) throw new OsAgentError("rauc_compatible_unknown");
	const compatible = matches[0]?.split("=")[1]?.trim();
	switch (compatible) {
		case "ceralive-rock-5b-plus":
			return { board: "rock-5b-plus", compatible };
		case "ceralive-orangepi5-plus":
			return { board: "orange-pi-5-plus", compatible };
		default:
			throw new OsAgentError("rauc_compatible_unknown");
	}
}
