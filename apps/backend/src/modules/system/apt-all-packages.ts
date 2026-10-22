import type { UpdatePackage } from "@ceraui/rpc";
import {
	type AptAllDiagnosticStep,
	prepareAptDiagnostic,
} from "./apt-all-diagnostics.ts";
import { policySources } from "./apt-all-source-policy.ts";
import { APT_PACKAGE_NAME_RE } from "./apt-package-name.ts";
import {
	parseAptSimulationRow,
	APT_SIMULATION_VERSION_RE as VERSION_RE,
} from "./apt-simulation-row.ts";

export type PinnedAptPackage = {
	readonly name: string;
	readonly version: string;
};
export type AptAllRefusal =
	| "removals_required"
	| "first_party_held_back"
	| "discovery_failed";

export class AptAllRefusalError extends Error {
	readonly exit: number | undefined;
	readonly detail: string | undefined;
	readonly fingerprint: string | undefined;
	constructor(
		readonly reason: AptAllRefusal,
		readonly step: AptAllDiagnosticStep,
		diagnostic?: { readonly exit?: number; readonly detail?: string },
	) {
		super(reason);
		this.name = "AptAllRefusalError";
		this.exit = diagnostic?.exit;
		const sanitized =
			diagnostic?.detail === undefined
				? undefined
				: prepareAptDiagnostic(diagnostic.detail);
		this.detail = sanitized?.detail;
		this.fingerprint = sanitized?.fingerprint;
	}
}

const FIRST_PARTY =
	/^(?:ceralive-|cerastream$|srtla$|libsrt1\.5-ceralive$|gstreamer1\.0-(?:libuvcsrc|rockchip-ceralive)$|librga2-ceralive$|lib(?:mm-glib0|mbim-(?:glib4|proxy|utils)|qmi-(?:glib5|proxy|utils)|qrtr-glib0)$|modemmanager$)/;

export function parseAptSimulation(
	text: string,
	step: "parse-simulation" | "pinned-recheck" = "parse-simulation",
): PinnedAptPackage[] {
	if (text.split("\n").some((line) => /^(?:Remv|Purg)(?:\s|$)/.test(line))) {
		throw new AptAllRefusalError("removals_required", step, {
			detail: "simulation requires removals",
		});
	}
	const result: PinnedAptPackage[] = [];
	const names = new Set<string>();
	for (const line of text.split("\n")) {
		if (
			/^(?:(?:Reading (?:package lists|state information)|Building dependency tree|Calculating upgrade)\.\.\.|Done ordering|Candidate versions|Dependency generation|Broken packages|Remove packages|Calculating upgrade|Aborting install\.)$/.test(
				line,
			)
		)
			continue;
		if (
			!/^(?:(?:Inst|Conf|Remv|Purg)(?:\s|$)|[A-Z][A-Za-z]* [a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?(?:$| \[| \([0-9]))/.test(
				line,
			)
		)
			continue;
		const row = parseAptSimulationRow(line);
		if (
			!row ||
			(row.kind === "Inst" && (!row.version || names.has(row.name)))
		) {
			throw new AptAllRefusalError("discovery_failed", step, {
				detail: `invalid or duplicate ${line.startsWith("Inst") ? "Inst" : "simulation"} row: ${line}`,
			});
		}
		switch (row.kind) {
			case "Inst":
				if (row.version) result.push({ name: row.name, version: row.version });
				names.add(row.name);
				break;
			case "Conf":
				break;
			case "Remv":
			case "Purg":
				throw new AptAllRefusalError("removals_required", step);
			default: {
				const exhaustive: never = row;
				return exhaustive;
			}
		}
	}
	if (!text.includes("0 upgraded") && result.length === 0)
		throw new AptAllRefusalError("discovery_failed", step, {
			detail: "missing upgrade summary",
		});
	return result;
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
		throw new AptAllRefusalError("first_party_held_back", "held-packages", {
			detail: "first-party package held",
		});
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

// The detached unit's first stage, run earlier so the unit's own fetch finds every archive cached.
export function buildAptAllDownloadArgs(family: readonly string[]): string[] {
	return [
		"/usr/bin/apt-get",
		"-d",
		"-y",
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
		throw new AptAllRefusalError("discovery_failed", "install-vector", {
			detail: "empty or invalid package/version vector",
		});
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
	const actual = parseAptSimulation(text, "pinned-recheck");
	if (
		actual.length !== pairs.length ||
		actual.some(
			({ name, version }) =>
				!pairs.some((pair) => pair.name === name && pair.version === version),
		)
	) {
		throw new AptAllRefusalError("discovery_failed", "pinned-recheck", {
			detail: `pinned package/version mismatch: ${actual.map(({ name, version }) => `${name}=${version}`).join(", ")}`,
		});
	}
}
