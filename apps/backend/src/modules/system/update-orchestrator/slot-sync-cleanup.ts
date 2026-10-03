import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanAptCache } from "../apt-cache-clean.ts";
import type { QuarantinedPackage, UpdateQuarantine } from "./quarantine.ts";

const RAUC_DOWNLOADS = "/data/ceralive/rauc-downloads";

export { cleanAptCache };

export async function removeRaucDownloads(): Promise<void> {
	const entries = await readdir(RAUC_DOWNLOADS).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	});
	for (const entry of entries)
		await rm(join(RAUC_DOWNLOADS, entry), { recursive: true, force: true });
}

export function parseInstalledPackages(status: string): QuarantinedPackage[] {
	return status.split(/\n\s*\n/).flatMap((paragraph) => {
		const fields = new Map(
			paragraph
				.split("\n")
				.filter((line) => !/^\s/.test(line))
				.map((line) => [
					line.slice(0, line.indexOf(":")),
					line.slice(line.indexOf(":") + 1).trim(),
				]),
		);
		const name = fields.get("Package");
		const version = fields.get("Version");
		return fields.get("Status")?.endsWith(" ok installed") && name && version
			? [{ name, version }]
			: [];
	});
}

export async function dropSupersededQuarantine(
	quarantine: UpdateQuarantine,
): Promise<void> {
	const installed = parseInstalledPackages(
		await Bun.file("/var/lib/dpkg/status").text(),
	);
	// The existing exact-version reconciliation only removes failed candidates
	// beaten by a newer installed version; OS rollback evidence remains intact.
	await quarantine.reconcileCandidates(installed);
}
