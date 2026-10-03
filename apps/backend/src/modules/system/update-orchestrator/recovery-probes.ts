import { readdir } from "node:fs/promises";
import { z } from "zod";
import { SOFTWARE_UPDATE_UNIT } from "../software-update-service-contract.ts";
import { readBoardIdentity, readBootId } from "./os-identity.ts";
import { readBootedOsReleaseVersion } from "./os-manifest.ts";
import type { RecoveryIdentity } from "./recovery-store.ts";

const statusSchema = z.object({
	slots: z.array(
		z.record(z.string(), z.object({ class: z.string(), state: z.string() })),
	),
});
const BUSY_NAMES = new Set([
	"apt",
	"apt-get",
	"dpkg",
	"dpkg-deb",
	"unattended-upgr",
	"rauc-nbd",
]);
const OTHER_UNITS = [
	"ceralive-slot-sync.service",
	"ceralive-rauc-arm@arm.service",
	"apt-daily.service",
	"apt-daily-upgrade.service",
] as const;

export interface RecoveryProbes {
	root(): boolean;
	backendStopped(): Promise<boolean>;
	unitAbsent(): Promise<boolean>;
	operationsIdle(): Promise<boolean>;
	dpkgClean(): Promise<boolean>;
	identity(): Promise<
		Pick<RecoveryIdentity, "bootId" | "slot" | "compatible" | "osVersion">
	>;
	candidateUnapplied(name: string, version: string): Promise<boolean>;
}

export interface RecoveryCommandResult {
	readonly code: number;
	readonly stdout: string;
}
export interface RecoveryProbeIo {
	run(argv: readonly string[]): Promise<RecoveryCommandResult>;
	read(path: string): Promise<string>;
	list(path: string): Promise<readonly string[]>;
}

async function runChecked(
	io: RecoveryProbeIo,
	argv: readonly string[],
): Promise<string> {
	const result = await io.run(argv);
	if (result.code !== 0) throw new RecoveryProbeError("command_unreadable");
	return result.stdout;
}

export class RecoveryProbeError extends Error {
	override readonly name = "RecoveryProbeError";
	constructor(readonly reason: string) {
		super(reason);
	}
}

async function unitProperties(
	io: RecoveryProbeIo,
	name: string,
): Promise<Map<string, string>> {
	const result = await io.run([
		"systemctl",
		"show",
		name,
		"--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job",
		"--no-pager",
	]);
	if (result.code !== 0) throw new RecoveryProbeError("unit_unreadable");
	const pairs = result.stdout
		.trim()
		.split("\n")
		.map((line) => line.split("="));
	return new Map(
		pairs
			.filter((pair) => pair.length === 2)
			.map((pair) => [pair[0] ?? "", pair[1] ?? ""]),
	);
}

export function createRecoveryProbes(
	io: RecoveryProbeIo,
	root = () => process.getuid?.() === 0,
): RecoveryProbes {
	return {
		root,
		backendStopped: async () => {
			const unit = await unitProperties(io, "ceralive.service");
			return (
				unit.get("LoadState") === "masked" &&
				unit.get("ActiveState") === "inactive" &&
				unit.get("SubState") === "dead" &&
				unit.get("MainPID") === "0" &&
				unit.get("ControlPID") === "0" &&
				(unit.get("Job") === "0" || unit.get("Job") === "")
			);
		},
		unitAbsent: async () =>
			(await unitProperties(io, SOFTWARE_UPDATE_UNIT)).get("LoadState") ===
			"not-found",
		operationsIdle: async () => {
			const entries = await io.list("/proc");
			for (const entry of entries) {
				if (!/^[0-9]+$/.test(entry)) continue;
				let comm: string;
				try {
					comm = (await io.read(`/proc/${entry}/comm`)).trim();
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					)
						continue;
					throw error;
				}
				if (BUSY_NAMES.has(comm)) return false;
			}
			for (const name of OTHER_UNITS) {
				const unit = await unitProperties(io, name);
				if (unit.get("ActiveState") !== "inactive") return false;
			}
			const operation = await runChecked(io, [
				"busctl",
				"get-property",
				"de.pengutronix.rauc",
				"/",
				"de.pengutronix.rauc.Installer",
				"Operation",
			]);
			return operation.trim() === 's "idle"';
		},
		dpkgClean: async () => {
			const audit = await runChecked(io, ["dpkg", "--audit"]);
			return (
				audit.trim() === "" &&
				(await io.list("/var/lib/dpkg/updates")).length === 0
			);
		},
		identity: async () => {
			const status = statusSchema.parse(
				JSON.parse(
					await runChecked(io, [
						"rauc",
						"status",
						"--detailed",
						"--output-format=json",
					]),
				),
			);
			const booted = status.slots.flatMap((entry) =>
				Object.entries(entry)
					.filter(
						([, slot]) => slot.class === "rootfs" && slot.state === "booted",
					)
					.map(([name]) => name),
			);
			const { compatible } = await readBoardIdentity();
			const osVersion = await readBootedOsReleaseVersion();
			if (booted.length !== 1 || !osVersion)
				throw new RecoveryProbeError("identity_unreadable");
			if (compatible !== "ceralive-rock-5b-plus")
				throw new RecoveryProbeError("wrong_board");
			return {
				bootId: await readBootId(),
				slot: booted[0] ?? "",
				compatible,
				osVersion,
			};
		},
		candidateUnapplied: async (name, version) => {
			const result = await io.run([
				"dpkg-query",
				"-W",
				"-f=$" + "{Status}\t$" + "{Version}",
				name,
			]);
			if (result.code === 1 && result.stdout.trim() === "") return true;
			if (result.code !== 0) throw new RecoveryProbeError("package_unreadable");
			const match =
				/^(install ok installed|deinstall ok config-files)\t(\S+)\s*$/.exec(
					result.stdout,
				);
			if (!match) throw new RecoveryProbeError("package_unreadable");
			return match[1] === "deinstall ok config-files" || match[2] !== version;
		},
	};
}

export const defaultRecoveryProbeIo: RecoveryProbeIo = {
	run: async (argv) => {
		const child = Bun.spawn([...argv], {
			stdout: "pipe",
			stderr: "pipe",
			signal: AbortSignal.timeout(10_000),
			env: { ...process.env, LC_ALL: "C" },
		});
		const [stdout, , code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, stdout };
	},
	read: (path) => Bun.file(path).text(),
	list: readdir,
};
