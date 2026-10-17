import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanAptCache } from "../apt-cache-clean.ts";
import type { QuarantinedPackage, UpdateQuarantine } from "./quarantine.ts";
import {
	readStoredStateFile,
	STORED_STATE_LIMITS,
} from "./stored-state-file.ts";

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
		const fields = new Map<string, string>();
		for (const line of paragraph.split("\n")) {
			if (line === "" || /^\s/.test(line)) continue;
			const at = line.indexOf(":");
			const key = line.slice(0, at);
			if (at < 1 || fields.has(key))
				throw new PackageStatusReadError("ambiguous package status");
			fields.set(key, line.slice(at + 1).trim());
		}
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
	const status = await readStoredStateFile(
		"/var/lib/dpkg/status",
		STORED_STATE_LIMITS.quarantine,
	);
	if (status === null)
		throw new PackageStatusReadError("package status absent");
	const installed = parseInstalledPackages(status);
	// The existing exact-version reconciliation only removes failed candidates
	// beaten by a newer installed version; OS rollback evidence remains intact.
	await quarantine.reconcileCandidates(installed);
}

export class PackageStatusReadError extends Error {
	override readonly name = "PackageStatusReadError";
}
