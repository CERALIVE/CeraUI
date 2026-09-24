import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomicSync } from "../../../helpers/config-loader.ts";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";

export const QUARANTINE_FILE = "/data/ceralive/update-state/quarantine.json";
export const QUARANTINE_PIN_FILE = "/etc/apt/preferences.d/ceralive-quarantine";
const PENDING_FILE = "/data/ceralive/update-state/pending-packages.json";
const packageName = z.string().regex(/^[a-z0-9][a-z0-9+.-]*$/);
const version = z.string().regex(/^[0-9][a-zA-Z0-9.+:~_-]*$/);

/**
 * Cross-task schema v1 (Todo 39 reads `os` to skip a rolled-back manifest):
 * {"schema":1,"packages":[{"name":"cerastream","version":"2026.9.10"}],
 *  "os":[{"version":"2026.10.0","bootedVersion":"2026.9.1"}],
 *  "failedCommits":[{"id":"transaction-id","reason":"apt-exit-1"}]}.
 * `packages` keys on exact (name, failed candidate version); `os.version` is
 * the EXPECTED staged version that failed activation, NEVER the surviving slot.
 * `bootedVersion` is diagnostic only. No wildcard pins and no guessed versions.
 */
export const quarantineSchema = z.object({
	schema: z.literal(1),
	packages: z.array(z.object({ name: packageName, version })),
	os: z.array(z.object({ version, bootedVersion: version })),
	failedCommits: z.array(z.object({ id: z.string().min(1), reason: z.string().min(1) })),
}).strict();
export type QuarantineDocument = z.infer<typeof quarantineSchema>;
export type QuarantinedPackage = QuarantineDocument["packages"][number];
const pendingSchema = z.array(z.object({ name: packageName, version: version.optional() }));
export type PendingPackage = z.infer<typeof pendingSchema>[number];
const EMPTY: QuarantineDocument = { schema: 1, packages: [], os: [], failedCommits: [] };

export async function writeQuarantinePins(text: string): Promise<void> {
	// PID 1 owns the privileged install; the backend only writes a private source
	// in /data. argv-only, fixed destination, no shell or caller-supplied path.
	const source = `${QUARANTINE_FILE}.${process.pid}.pins`;
	await mkdir(dirname(source), { recursive: true, mode: 0o700 });
	writeFileAtomicSync(source, text);
	try {
		const result = await spawnWithTimeout([
			"systemd-run", "--wait", "--collect", "--quiet", "--",
			"/usr/bin/install", "-m", "0644", source, QUARANTINE_PIN_FILE,
		], { timeoutMs: 30_000 });
		if (result.exitCode !== 0) throw new Error("Quarantine pin install failed");
	} finally {
		await Bun.file(source).delete();
	}
}

export class UpdateQuarantine {
	constructor(
		private readonly path = QUARANTINE_FILE,
		private readonly writePins: (text: string) => Promise<void> = writeQuarantinePins,
	) {}

	async read(): Promise<QuarantineDocument> {
		if (!(await Bun.file(this.path).exists())) return EMPTY;
		return quarantineSchema.parse(await Bun.file(this.path).json());
	}

	private async persist(doc: QuarantineDocument): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		writeFileAtomicSync(this.path, JSON.stringify(quarantineSchema.parse(doc)));
	}

	private async pin(packages: readonly QuarantinedPackage[]): Promise<void> {
		await this.writePins(packages.map(({ name, version: bad }) =>
			`Package: ${name}\nPin: version ${bad}\nPin-Priority: -1\n\n`,
		).join(""));
	}

	async savePending(packages: readonly PendingPackage[]): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		writeFileAtomicSync(this.pendingPath(), JSON.stringify(pendingSchema.parse(packages)));
	}

	async readPending(): Promise<PendingPackage[]> {
		const path = this.pendingPath();
		if (!(await Bun.file(path).exists())) return [];
		return pendingSchema.parse(await Bun.file(path).json());
	}

	async clearPending(): Promise<void> {
		if (await Bun.file(this.pendingPath()).exists()) await Bun.file(this.pendingPath()).delete();
	}

	private pendingPath(): string {
		return this.path === QUARANTINE_FILE ? PENDING_FILE : `${this.path}.pending`;
	}

	async recordPackageFailure(packages: readonly QuarantinedPackage[], id = "unknown-commit", reason = "apt-exit-nonzero"): Promise<void> {
		const doc = await this.read();
		const next = quarantineSchema.parse({ ...doc, packages: [
			...doc.packages,
			...packages.filter((p) => !doc.packages.some((q) => q.name === p.name && q.version === p.version)),
		], failedCommits: doc.failedCommits.some((item) => item.id === id)
			? doc.failedCommits : [...doc.failedCommits, { id, reason }] });
		await this.pin(next.packages); // fail closed before recording a version as protected
		await this.persist(next);
	}

	async recordOsRollback(expectedVersion: string, bootedVersion: string): Promise<void> {
		const doc = await this.read();
		if (expectedVersion === bootedVersion || doc.os.some((item) => item.version === expectedVersion)) return;
		await this.persist({ ...doc, os: [...doc.os, { version: expectedVersion, bootedVersion }] });
	}

	async isOsVersionQuarantined(candidate: string): Promise<boolean> {
		return (await this.read()).os.some(({ version: bad }) => bad === candidate);
	}

	async reconcileCandidates(
		candidates: readonly QuarantinedPackage[],
		newer: (candidate: string, bad: string) => Promise<boolean> = async (candidate, bad) => {
			const result = await spawnWithTimeout(["dpkg", "--compare-versions", candidate, "gt", bad], { timeoutMs: 10_000 });
			return result.exitCode === 0;
		},
	): Promise<void> {
		const doc = await this.read();
		const kept: QuarantinedPackage[] = [];
		for (const bad of doc.packages) {
			const candidate = candidates.find((item) => item.name === bad.name);
			if (!candidate || !(await newer(candidate.version, bad.version))) kept.push(bad);
		}
		if (kept.length === doc.packages.length) return;
		await this.pin(kept);
		await this.persist({ ...doc, packages: kept });
	}
}
