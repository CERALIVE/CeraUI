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
		const match =
			/^Inst (\S+) (?:\[[0-9][A-Za-z0-9.+:~-]*\] )?\(([0-9][A-Za-z0-9.+:~-]*) [A-Za-z0-9][A-Za-z0-9.+:/_-]*(?:(?:, *| +)[A-Za-z0-9][A-Za-z0-9.+:/_-]*)* \[[a-z0-9][a-z0-9-]*\]\)$/.exec(
				line,
			);
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

function sourceOrigin(
	source: string,
	release: string,
	origin: string,
): string | null {
	const url = /^https:\/\/\S+/.exec(source)?.[0];
	if (!url || !URL.canParse(url)) return null;
	const host = new URL(url).hostname;
	if (host !== origin) return null;
	if (
		host === "apt.ceralive.tv" &&
		/(?:^|,)o=CeraLive(?:,|$)/.test(release) &&
		/(?:^|,)l=CeraLive(?:,|$)/.test(release) &&
		/(?:^|,)n=(?:stable|beta)(?:,|$)/.test(release)
	)
		return host;
	const suite = /(?:^|,)n=(trixie(?:-updates|-security)?)(?:,|$)/.exec(
		release,
	)?.[1];
	if (
		(host === "deb.debian.org" || host === "security.debian.org") &&
		/(?:^|,)o=Debian(?:,|$)/.test(release) &&
		/(?:^|,)l=Debian(?:-Security)?(?:,|$)/.test(release) &&
		suite
	)
		return `Debian ${suite}`;
	return null;
}

function policySources(inventory: string): Map<string, string | null> {
	const sources = new Map<string, string | null>();
	const lines = inventory.split("\n");
	if (lines[0] !== "Package files:") return sources;
	for (let i = 1; i < lines.length && lines[i] !== "Pinned packages:"; i++) {
		const source = /^\s*\d+\s+(https?:\/\/\S+\s+.+\s+Packages)\s*$/.exec(
			lines[i] ?? "",
		)?.[1];
		if (!source) continue;
		const release = /^\s+release\s+(.+)$/.exec(lines[i + 1] ?? "")?.[1];
		const origin = /^\s+origin\s+(\S+)\s*$/.exec(lines[i + 2] ?? "")?.[1];
		const allowed =
			release && origin ? sourceOrigin(source, release, origin) : null;
		if (sources.has(source) && sources.get(source) !== allowed) {
			sources.set(source, null);
		} else if (!sources.has(source)) {
			sources.set(source, allowed);
		}
	}
	return sources;
}

export function candidateOrigin(
	policy: string,
	version: string,
	sources: ReadonlyMap<string, string | null>,
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
		const source = /^\s+\d+\s+(https?:\/\/\S+\s+.+\s+Packages)\s*$/.exec(
			line,
		)?.[1];
		if (!source) continue;
		const origin = sources.get(source);
		if (!origin) return null;
		allowedOrigin ??= origin;
	}
	return allowedOrigin;
}

export async function discoverAptAllPackages(
	simulation: string,
	holds: string,
	policyFor: (name: string) => Promise<string>,
	sourcePolicy: string,
): Promise<{
	readonly packages: UpdatePackage[];
	readonly actionable: PinnedAptPackage[];
}> {
	const held = new Set(holds.trim().split(/\s+/).filter(Boolean));
	if ([...held].some((name) => FIRST_PARTY.test(name)))
		throw new AptAllRefusalError("first_party_held_back");
	const simulated = parseAptSimulation(simulation);
	const sources = policySources(sourcePolicy);
	const packages: UpdatePackage[] = [];
	const actionable: PinnedAptPackage[] = [];
	for (const pair of simulated) {
		const origin = candidateOrigin(
			await policyFor(pair.name),
			pair.version,
			sources,
		);
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
