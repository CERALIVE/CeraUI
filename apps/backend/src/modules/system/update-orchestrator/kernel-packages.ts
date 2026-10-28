import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chown, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { UpdateCapabilities } from "@ceraui/rpc/schemas";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { CERALIVE_SOURCES_FILE } from "../update-apt-channel.ts";
import { hasKernelAptStage } from "../update-capabilities.ts";
import {
	type KernelIdentity,
	KernelUpdateError,
	kernelIdentitySchema,
	kernelPackage,
	kernelVersion,
} from "./kernel-state.ts";

export type KernelPackageRecord = KernelIdentity & {
	readonly filename: string;
	readonly size: number;
};
type Run = typeof spawnWithTimeout;
export const kernelSourceArgs = (source = CERALIVE_SOURCES_FILE): string[] => [
	"-o",
	`Dir::Etc::SourceList=${source}`,
	"-o",
	"Dir::Etc::SourceParts=/dev/null",
];

/** deb822 field names are case insensitive; duplicate authority is never last-wins. */
export function parseKernelDeb822(text: string): ReadonlyMap<string, string>[] {
	if (text.includes("\0") || text.includes("\r"))
		throw new KernelUpdateError("kernel_discovery_failed");
	return text
		.trim()
		.split(/\n[ \t]*\n/)
		.filter(Boolean)
		.map((block) => {
			const fields = new Map<string, string>();
			let previous = "";
			for (const line of block.split("\n")) {
				if (/^[ \t]/.test(line) && previous) {
					fields.set(previous, `${fields.get(previous)}\n${line.slice(1)}`);
					continue;
				}
				const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
				if (!match?.[1] || match[2] === undefined)
					throw new KernelUpdateError("kernel_discovery_failed");
				previous = match[1].toLowerCase();
				if (fields.has(previous))
					throw new KernelUpdateError("kernel_discovery_failed");
				fields.set(previous, match[2]);
			}
			return fields;
		});
}

export function parseKernelPackages(text: string): KernelPackageRecord[] {
	return parseKernelDeb822(text).flatMap((row) => {
		const name = row.get("package");
		if (!name || !kernelPackage.safeParse(name).success) return [];
		const identity = kernelIdentitySchema.safeParse({
			package: name,
			version: row.get("version"),
			deb_sha256: row.get("sha256"),
		});
		const filename = row.get("filename") ?? "";
		const size = row.get("size") ?? "";
		if (
			!identity.success ||
			row.get("architecture") !== "arm64" ||
			!/^(?:\.\/)?[A-Za-z0-9+_.-]+(?:\/[A-Za-z0-9+_.-]+)*\.deb$/.test(
				filename,
			) ||
			filename.split("/").some((part) => part === "..") ||
			!/^[1-9][0-9]*$/.test(size) ||
			!Number.isSafeInteger(Number(size))
		)
			throw new KernelUpdateError("kernel_discovery_failed");
		return [{ ...identity.data, filename, size: Number(size) }];
	});
}

export async function kernelVersionGreater(
	left: string,
	right: string,
	run: Run = spawnWithTimeout,
): Promise<boolean> {
	kernelVersion.parse(left);
	kernelVersion.parse(right);
	const result = await run(["dpkg", "--compare-versions", left, "gt", right], {
		timeoutMs: 2_000,
	});
	if (result.exitCode !== 0 && result.exitCode !== 1)
		throw new KernelUpdateError("kernel_discovery_failed");
	return result.exitCode === 0;
}

export async function selectKernelPackage(
	caps: UpdateCapabilities,
	records: readonly KernelPackageRecord[],
	booted: Pick<KernelIdentity, "package" | "version">,
	quarantine: readonly KernelIdentity[],
	greater = kernelVersionGreater,
): Promise<KernelPackageRecord | null> {
	if (!hasKernelAptStage(caps)) return null;
	let candidate: KernelPackageRecord | null = null;
	const seen = new Map<string, KernelPackageRecord>();
	for (const record of records) {
		const key = `${record.package}=${record.version}`;
		const prior = seen.get(key);
		if (
			prior &&
			(prior.deb_sha256 !== record.deb_sha256 || prior.size !== record.size)
		)
			throw new KernelUpdateError("kernel_origin_mismatch");
		seen.set(key, record);
		if (
			quarantine.some(
				(q) => q.package === record.package && q.version === record.version,
			)
		)
			continue;
		if (await greater(record.version, candidate?.version ?? booted.version))
			candidate = record;
	}
	return candidate;
}

export async function readAuthenticatedKernelPackages(
	run: Run = spawnWithTimeout,
	source = CERALIVE_SOURCES_FILE,
): Promise<readonly KernelPackageRecord[]> {
	const indexes = await run(
		[
			"/usr/bin/apt-get",
			...kernelSourceArgs(source),
			"indextargets",
			"Identifier: Packages",
		],
		{ timeoutMs: 10_000, maxBuffer: 1_048_576 },
	);
	if (indexes.exitCode !== 0)
		throw new KernelUpdateError("kernel_discovery_failed");
	const records: KernelPackageRecord[] = [];
	for (const target of parseKernelDeb822(indexes.stdout)) {
		const uri = target.get("uri") ?? "";
		const file = target.get("filename") ?? "";
		if (
			target.get("trusted") !== "yes" ||
			target.get("origin") !== "CeraLive" ||
			target.get("label") !== "CeraLive" ||
			!/^https:\/\/apt\.ceralive\.tv\/dists\/(?:stable|beta)\/binary-arm64\/(?:\.\/)?Packages$/.test(
				uri,
			) ||
			!file.startsWith("/var/lib/apt/lists/") ||
			file.includes("/../")
		)
			throw new KernelUpdateError("kernel_origin_mismatch");
		const data = await run(["/usr/lib/apt/apt-helper", "cat-file", file], {
			timeoutMs: 10_000,
			maxBuffer: 8 * 1024 * 1024,
		});
		if (data.exitCode !== 0)
			throw new KernelUpdateError("kernel_discovery_failed");
		records.push(...parseKernelPackages(data.stdout));
	}
	return records;
}

export async function readBootedKernel(
	run: Run = spawnWithTimeout,
): Promise<Pick<KernelIdentity, "package" | "version">> {
	const release = await run(["uname", "-r"], { timeoutMs: 2_000 });
	const name = `linux-image-${release.stdout.trim()}`;
	if (release.exitCode !== 0 || !kernelPackage.safeParse(name).success)
		throw new KernelUpdateError("kernel_identity_mismatch");
	const installed = await run(
		["dpkg-query", "-W", "-f=$" + "{db:Status-Status}\\t$" + "{Version}", name],
		{ timeoutMs: 2_000 },
	);
	const match = /^installed\t([^\n]+)\n?$/.exec(installed.stdout);
	if (
		installed.exitCode !== 0 ||
		!match?.[1] ||
		!kernelVersion.safeParse(match[1]).success
	)
		throw new KernelUpdateError("kernel_identity_mismatch");
	return { package: name, version: match[1] };
}

export async function verifyKernelDownload(
	file: string,
	record: KernelPackageRecord,
	run: Run = spawnWithTimeout,
): Promise<void> {
	const handle = await open(
		file,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size !== record.size)
			throw new KernelUpdateError("kernel_origin_mismatch");
		const hash = createHash("sha256");
		for await (const chunk of handle.createReadStream({ autoClose: false }))
			hash.update(chunk);
		if (hash.digest("hex") !== record.deb_sha256)
			throw new KernelUpdateError("kernel_origin_mismatch");
	} finally {
		await handle.close();
	}
	const control = await run(["dpkg-deb", "--field", file], {
		timeoutMs: 10_000,
		maxBuffer: 65_536,
	});
	const rows = parseKernelDeb822(control.stdout);
	const row = rows[0];
	if (
		control.exitCode !== 0 ||
		rows.length !== 1 ||
		row?.get("package") !== record.package ||
		row.get("version") !== record.version ||
		row.get("architecture") !== "arm64"
	)
		throw new KernelUpdateError("kernel_origin_mismatch");
}

export async function downloadKernelPackage(
	record: KernelPackageRecord,
	uid: number,
	directory: string,
	signal: AbortSignal,
	run: Run = spawnWithTimeout,
	source = CERALIVE_SOURCES_FILE,
): Promise<string> {
	if (!Number.isSafeInteger(uid) || uid <= 0)
		throw new KernelUpdateError("kernel_download_failed");
	await chown(directory, uid, uid);
	const result = await run(
		[
			"setpriv",
			`--reuid=${uid}`,
			`--regid=${uid}`,
			"--clear-groups",
			"/usr/bin/env",
			`--chdir=${directory}`,
			"/usr/bin/apt-get",
			...kernelSourceArgs(source),
			"download",
			`${record.package}=${record.version}`,
		],
		{ timeoutMs: 300_000, signal },
	);
	if (result.exitCode !== 0)
		throw new KernelUpdateError("kernel_download_failed");
	// Retire the downloader's directory authority before opening its result.
	await chown(directory, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
	const files = await readdir(directory);
	if (files.length !== 1 || !files[0]?.endsWith(".deb"))
		throw new KernelUpdateError("kernel_origin_mismatch");
	const file = join(directory, files[0]);
	await verifyKernelDownload(file, record, run);
	return file;
}
