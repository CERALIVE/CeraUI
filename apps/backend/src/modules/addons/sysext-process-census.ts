import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import type { ServiceCompletion } from "../system/disruptive-service-reservation.ts";
import { observationAbsent } from "../system/update-orchestrator/os-stage-read-errors.ts";

const SYSEXT_ACTORS = new Set(["ceralive-addon-helper", "systemd-sysext"]);
export type ProcIo = {
	readonly read: (file: string) => Promise<string>;
	readonly list: (dir: string) => Promise<readonly string[]>;
	readonly link: (file: string) => Promise<string>;
};
const hostProcIo: ProcIo = {
	read: (file) => readFile(file, "utf8"),
	list: (dir) => readdir(dir),
	link: (file) => readlink(file),
};
let procRoot = "/proc";
let procIo = hostProcIo;
const SUDO_VALUE_OPTIONS = new Set([
	"-C",
	"-D",
	"-R",
	"-T",
	"-U",
	"-g",
	"-h",
	"-p",
	"-r",
	"-t",
	"-u",
	"--chdir",
	"--chroot",
	"--close-from",
	"--command-timeout",
	"--group",
	"--host",
	"--other-user",
	"--prompt",
	"--role",
	"--type",
	"--user",
]);
const SCRIPT_INTERPRETERS = new Set(["bash", "dash", "sh"]);

export function executableIdentity(argv: readonly string[]): string {
	let index = 0;
	for (;;) {
		const name = path.basename(argv[index] ?? "");
		if (name === "sudo" || name === "env") {
			index++;
			for (let arg = argv[index]; arg !== undefined; arg = argv[index]) {
				if (arg === "--") {
					index++;
					break;
				}
				if (!arg.startsWith("-") && !(name === "env" && arg.includes("=")))
					break;
				index += name === "sudo" && SUDO_VALUE_OPTIONS.has(arg) ? 2 : 1;
			}
			continue;
		}
		const script = argv[index + 1];
		return SCRIPT_INTERPRETERS.has(name) &&
			script !== undefined &&
			!script.startsWith("-")
			? path.basename(script)
			: name;
	}
}

export async function probeSysextActors(
	_scope: unknown,
	signal: AbortSignal,
): Promise<ServiceCompletion> {
	try {
		if ((await procIo.read(path.join(procRoot, "1", "cmdline"))).length === 0)
			return "unknown";
		let entries = (await procIo.list(procRoot)).filter((pid) =>
			/^\d+$/.test(pid),
		);
		for (let pass = 0; pass < 4; pass++) {
			if (!entries.includes("1")) return "unknown";
			let vanished = false;
			const read = new Set<string>();
			for (const entry of entries) {
				if (signal.aborted) return "unknown";
				try {
					const cmdline = await procIo.read(
						path.join(procRoot, entry, "cmdline"),
					);
					if (entry === "1" && cmdline.length === 0) return "unknown";
					let exe: string;
					try {
						exe = await procIo.link(path.join(procRoot, entry, "exe"));
					} catch (error) {
						if (!observationAbsent(error, "process")) return "unknown";
						if (cmdline.length !== 0) throw error;
						const stat = await procIo.read(path.join(procRoot, entry, "stat"));
						const fields = /^\d+ \(.*\) ([A-Z]) (.*)$/.exec(stat);
						const flags = fields?.[2]?.split(" ")[5];
						if (!fields || !flags || !/^\d+$/.test(flags)) return "unknown";
						if (fields[1] !== "Z" && (Number(flags) & 0x00200000) === 0)
							return "unknown";
						exe = "";
					}
					if (
						path.basename(exe.replace(/ \(deleted\)$/, "")) ===
							"systemd-sysext" ||
						SYSEXT_ACTORS.has(executableIdentity(cmdline.split("\0")))
					)
						return "in-flight";
					read.add(entry);
				} catch (error) {
					if (!observationAbsent(error, "process")) return "unknown";
					vanished = true;
				}
			}
			const next = (await procIo.list(procRoot)).filter((pid) =>
				/^\d+$/.test(pid),
			);
			if (
				!signal.aborted &&
				!vanished &&
				next.includes("1") &&
				next.every((pid) => read.has(pid))
			)
				return "completed";
			entries = next;
		}
	} catch {
		return "unknown";
	}
	return "unknown";
}

export function setSysextCensusForTest(options?: {
	readonly procRoot?: string;
	readonly procIo?: ProcIo;
}): void {
	procRoot = options?.procRoot ?? "/proc";
	procIo = options?.procIo ?? hostProcIo;
}
