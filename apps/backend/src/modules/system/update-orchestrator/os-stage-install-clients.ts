import { readdir } from "node:fs/promises";

function installationExcluded(argv: readonly string[], url?: string): boolean {
	if (argv[0]?.split("/").at(-1) !== "rauc") return true;
	let index = 1;
	while (index < argv.length) {
		const option = argv[index] ?? "";
		if (option === "--debug" || option === "-d") {
			index++;
			continue;
		}
		if (
			["--conf", "-C", "--keyring", "--override-boot-slot", "--mount"].includes(
				option,
			)
		) {
			if (!argv[index + 1] || argv[index + 1]?.startsWith("-")) return false;
			index += 2;
			continue;
		}
		if (/^--(?:conf|keyring|override-boot-slot|mount)=.+$/.test(option)) {
			index++;
			continue;
		}
		if (option === "--") index++;
		break;
	}
	const command = argv[index];
	if (command === "install") {
		const target = argv[index + 1];
		return (
			url !== undefined &&
			target !== undefined &&
			!target.startsWith("-") &&
			target !== url
		);
	}
	// Only known non-installer commands prove exclusion; unknown/partial argv does not.
	return ["service", "status", "info", "help", "version"].includes(
		command ?? "",
	);
}

export async function osInstallClientsGone(
	url?: string,
	deps = {
		list: () => readdir("/proc"),
		read: (path: string) => Bun.file(path).text(),
	},
): Promise<boolean> {
	try {
		for (const pid of (await deps.list()).filter((name) =>
			/^[1-9][0-9]*$/.test(name),
		)) {
			let raw: string;
			try {
				raw = await deps.read(`/proc/${pid}/cmdline`);
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				)
					continue;
				return false;
			}
			const argv = raw.split("\0").filter(Boolean);
			if (!installationExcluded(argv, url)) return false;
		}
		return true;
	} catch {
		return false;
	}
}
