import type { UpdatePackage } from "@ceraui/rpc";
import { APT_PACKAGE_NAME_RE } from "./apt-package-name.ts";

export type PinnedAptPackage = {
	readonly name: string;
	readonly version: string;
};
export type AptAllRefusal =
	| "removals_required"
	| "first_party_held_back"
	| "discovery_failed";

export class AptAllRefusalError extends Error {
	constructor(readonly reason: AptAllRefusal) {
		super(reason);
		this.name = "AptAllRefusalError";
	}
}

const VERSION_RE = /^[0-9][A-Za-z0-9.+:~-]*$/;
const FIRST_PARTY =
	/^(?:ceralive-|cerastream$|srtla$|libsrt1\.5-ceralive$|gstreamer1\.0-(?:libuvcsrc|rockchip-ceralive)$|librga2-ceralive$|lib(?:mm-glib0|mbim-(?:glib4|proxy|utils)|qmi-(?:glib5|proxy|utils)|qrtr-glib0)$|modemmanager$)/;

export function parseAptSimulation(text: string): PinnedAptPackage[] {
	if (text.split("\n").some((line) => line.startsWith("Remv "))) {
		throw new AptAllRefusalError("removals_required");
	}
	const result: PinnedAptPackage[] = [];
	const names = new Set<string>();
	for (const line of text.split("\n")) {
		if (!line.startsWith("Inst ")) continue;
		const match = /^Inst (\S+) (?:\[[^\]]+\] )?\((\S+) .+\)$/.exec(line);
		if (
			!match ||
			!APT_PACKAGE_NAME_RE.test(match[1] ?? "") ||
			!VERSION_RE.test(match[2] ?? "") ||
			names.has(match[1] ?? "")
		) {
			throw new AptAllRefusalError("discovery_failed");
		}
		const name = match[1] ?? "";
		result.push({ name, version: match[2] ?? "" });
		names.add(name);
	}
	if (!text.includes("0 upgraded") && result.length === 0)
		throw new AptAllRefusalError("discovery_failed");
	return result;
}

export function candidateOrigin(
	policy: string,
	version: string,
): string | null {
	const candidate = /^\s*Candidate:\s*(\S+)/m.exec(policy)?.[1];
	if (candidate !== version) return null;
	const versionLine = policy
		.split("\n")
		.findIndex((line) =>
			new RegExp(
				`^\\s*(?:\\*\\*\\*\\s+)?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+\\d+\\s*$`,
			).test(line),
		);
	if (versionLine < 0) return null;
	const lines = policy.split("\n").slice(versionLine + 1);
	let allowedOrigin: string | null = null;
	for (const line of lines) {
		if (/^\s{2,}(?:\*\*\* )?\S+\s+\d+\s*$/.test(line)) break;
		const url = /^\s+\d+\s+(https?:\/\/\S+)/.exec(line)?.[1];
		if (!url) continue;
		const host = new URL(url).hostname;
		const origin = /^\s+origin\s+(\S+)/.exec(
			lines[lines.indexOf(line) + 2] ?? "",
		)?.[1];
		if (host === "apt.ceralive.tv" && origin === host) {
			allowedOrigin ??= host;
			continue;
		}
		const release = lines[lines.indexOf(line) + 1] ?? "";
		if (
			origin === host &&
			/^\s+release\s+/.test(release) &&
			/(?:\s|,)o=Debian(?:,|$)/.test(release) &&
			/(?:\s|,)n=trixie(?:-updates|-security)?(?:,|$)/.test(release)
		) {
			allowedOrigin ??= `Debian ${/n=(trixie(?:-updates|-security)?)/.exec(release)?.[1]}`;
			continue;
		}
		return null;
	}
	return allowedOrigin;
}

export async function discoverAptAllPackages(
	simulation: string,
	holds: string,
	policyFor: (name: string) => Promise<string>,
): Promise<{
	readonly packages: UpdatePackage[];
	readonly actionable: PinnedAptPackage[];
}> {
	const held = new Set(holds.trim().split(/\s+/).filter(Boolean));
	if ([...held].some((name) => FIRST_PARTY.test(name)))
		throw new AptAllRefusalError("first_party_held_back");
	const simulated = parseAptSimulation(simulation);
	const packages: UpdatePackage[] = [];
	const actionable: PinnedAptPackage[] = [];
	for (const pair of simulated) {
		const origin = candidateOrigin(await policyFor(pair.name), pair.version);
		const allowed = origin !== null && !held.has(pair.name);
		const layer = origin === null ? "platform" : "app";
		packages.push({
			name: pair.name,
			version: pair.version,
			...(origin === null ? {} : { origin }),
			layer,
			actionable: allowed,
			...(held.has(pair.name) ? { kept_back: true as const } : {}),
		});
		if (allowed) actionable.push(pair);
	}
	return {
		packages,
		actionable: actionable.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

export function buildAptAllDiscoveryArgs(family: readonly string[]): string[] {
	return [
		"/usr/bin/apt-get",
		"-s",
		"-o",
		"Debug::NoLocking=1",
		"upgrade",
		"--with-new-pkgs",
		...family,
	];
}

export function buildAptAllInstallArgs(
	pairs: readonly PinnedAptPackage[],
	verdict: "any" | "force_ipv4" | "force_ipv6",
): string[] {
	if (
		!pairs.length ||
		pairs.some(
			({ name, version }) =>
				!APT_PACKAGE_NAME_RE.test(name) || !VERSION_RE.test(version),
		)
	)
		throw new AptAllRefusalError("discovery_failed");
	const family =
		verdict === "any"
			? []
			: ["-o", `Acquire::ForceIPv${verdict === "force_ipv4" ? "4" : "6"}=true`];
	return [
		"-y",
		"--no-download",
		"--no-remove",
		"-o",
		"Dpkg::Options::=--force-confdef",
		"-o",
		"Dpkg::Options::=--force-confold",
		...family,
		"install",
		...pairs.map(({ name, version }) => `${name}=${version}`),
	];
}

export function assertPinnedInstallSimulation(
	text: string,
	pairs: readonly PinnedAptPackage[],
): void {
	const actual = parseAptSimulation(text);
	if (
		actual.length !== pairs.length ||
		actual.some(
			({ name, version }) =>
				!pairs.some((pair) => pair.name === name && pair.version === version),
		)
	) {
		throw new AptAllRefusalError("discovery_failed");
	}
}
