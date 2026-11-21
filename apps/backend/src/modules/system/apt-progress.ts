import type { UpdateProgress } from "@ceraui/rpc/schemas";
import { spawnWithTimeout } from "../../helpers/spawn-policy.ts";

export type SoftUpdateStatus = Omit<UpdateProgress, "result"> & {
	result?: string | 0;
};

let nativeArchitecture: Promise<string | undefined> | undefined;

export function readNativeAptArchitecture(): Promise<string | undefined> {
	// A display-only probe. Failure must never block launch or reattachment.
	nativeArchitecture ??= spawnWithTimeout(
		["/usr/bin/dpkg", "--print-architecture"],
		{ timeoutMs: 1_000 },
	).then(
		({ exitCode, stdout }) => {
			const arch = stdout.trim();
			return exitCode === 0 && /^[a-z0-9][a-z0-9-]*$/.test(arch)
				? arch
				: undefined;
		},
		() => undefined,
	);
	return nativeArchitecture;
}

const packageIdentity = "[a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?";
const packageIdentityPattern = new RegExp(`^${packageIdentity}$`);
const version = "[0-9][a-zA-Z0-9.+:~\\-]*";
// Only unpack/setup earn credit. Get/Fetched, Selecting, Preparing to unpack
// and Processing triggers are not package-step completions.
const dpkgActivityPattern = new RegExp(
	`(Unpacking|Setting up) (${packageIdentity}) \\(${version}\\)( over \\(${version}\\))? \\.\\.\\.(?=[\\r\\n'"\`])`,
	"g",
);
const installPlanBoundary =
	/Download complete and in download only mode[\r\n]+/g;
const quote = /['"`]/;

const failurePrefixes = [
	"dpkg: error processing package",
	"dpkg: error processing archive",
	"dpkg: dependency problems prevent configuration",
	"E: Sub-process /usr/bin/dpkg returned an error code",
];

function failureOffset(log: string): number {
	// APT's PTY can append a dpkg diagnostic to an unfinished postinst line.
	let first = -1;
	for (const marker of failurePrefixes) {
		const offset = log.indexOf(marker);
		if (offset >= 0 && (first < 0 || offset < first)) first = offset;
	}
	return first;
}

export function hasDpkgFailure(log: string): boolean {
	return failureOffset(log) >= 0;
}

export function hasPartialDpkgFailure(log: string): boolean {
	for (const marker of failurePrefixes) {
		for (let length = 1; length < marker.length; length++) {
			if (log.endsWith(marker.slice(0, length))) return true;
		}
	}
	return false;
}

function aptInstallPlan(
	output: string,
	canonical: (name: string) => string,
): Set<string> | undefined {
	const summaries = output.matchAll(
		/(?<upgrade>\d+) upgraded, (?<install>\d+) newly installed, (?:(?<reinstall>\d+) reinstalled, )?(?:(?<downgrade>\d+) downgraded, )?0 to remove(?: and \d+ not upgraded)?\.[\r\n]+/g,
	);
	const summary = summaries.next().value;
	if (!summary || !summaries.next().done) return undefined;
	const afterSummary = output.slice(summary.index + summary[0].length);
	if (/[1-9]\d* not fully installed or removed\.[\r\n]/.test(afterSummary))
		return undefined;

	const plan = new Set<string>();
	const counts = new Map<string, number>([
		["packages will be upgraded", Number(summary.groups?.upgrade)],
		["NEW packages will be installed", Number(summary.groups?.install)],
		["packages will be REINSTALLED", Number(summary.groups?.reinstall ?? 0)],
		["packages will be DOWNGRADED", Number(summary.groups?.downgrade ?? 0)],
	]);
	for (const [, heading, block] of output
		.slice(0, summary.index)
		.matchAll(
			/The following ([^:\r\n]+):[\r\n]+((?:[ \t]+[^\r\n]+[\r\n]+)+)/g,
		)) {
		if (heading === undefined || !counts.has(heading)) continue;
		const names = (block ?? "").trim().split(/\s+/);
		if (names.length !== counts.get(heading)) return undefined;
		counts.set(heading, 0);
		for (const name of names) {
			const resolved = canonical(name);
			if (!packageIdentityPattern.test(name) || plan.has(resolved))
				return undefined;
			plan.add(resolved);
		}
	}
	return plan.size > 0 && [...counts.values()].every((count) => count === 0)
		? plan
		: undefined;
}

export function deriveAptProgress(
	current: SoftUpdateStatus,
	output: string,
	pinnedInstall?: readonly string[],
	nativeArch?: string,
	stderrFailed = false,
): SoftUpdateStatus {
	const suffix = nativeArch ? `:${nativeArch}` : undefined;
	const canonical = (name: string) =>
		suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
	// Only an observed download-only boundary can attribute a combined log's
	// plan to the pinned install.
	const boundary = pinnedInstall
		? output.matchAll(installPlanBoundary).next().value
		: undefined;
	const firstActivity = output.matchAll(dpkgActivityPattern).next().value;
	const firstFailure = failureOffset(output);
	const installStart =
		boundary &&
		(!firstActivity || boundary.index < firstActivity.index) &&
		(firstFailure < 0 || boundary.index < firstFailure)
			? boundary.index + boundary[0].length
			: 0;
	const install = output.slice(installStart);
	const stop = firstFailure < 0 ? -1 : firstFailure - installStart;
	const prefix = stop < 0 ? install : install.slice(0, stop);
	// A later script echo cannot supply a plan after dpkg activity has begun.
	const firstInstallActivity = prefix
		.matchAll(dpkgActivityPattern)
		.next().value;
	const beforeDpkg = prefix.slice(0, firstInstallActivity?.index);
	const plan =
		!pinnedInstall || installStart > 0
			? aptInstallPlan(beforeDpkg, canonical)
			: undefined;
	let highestGet = current.downloading;
	for (const match of beforeDpkg.matchAll(/Get:(\d+)(?=[ \t])/g)) {
		highestGet = Math.max(highestGet, Number.parseInt(match[1] ?? "", 10));
	}
	const unpacked = new Set<string>();
	const configured = new Set<string>();
	const observedUnpacks = new Set<string>();
	let sawSetup = false;
	let ambiguous = false;
	for (const match of install.matchAll(dpkgActivityPattern)) {
		const [, action, token, previousVersion] = match;
		if (token === undefined) continue;
		const isUnpack = action === "Unpacking";
		if (!isUnpack && previousVersion) continue;
		const name = canonical(token);
		// A quoted record can be script output; it does not verify a step.
		if (
			quote.test(install[match.index - 1] ?? "") ||
			quote.test(install[match.index + match[0].length] ?? "")
		) {
			ambiguous ||=
				Boolean(plan?.has(name)) && (stop < 0 || match.index < stop);
			continue;
		}
		if (isUnpack) observedUnpacks.add(name);
		else if (!plan || plan.has(name) || observedUnpacks.has(name))
			sawSetup = true;
		if (stderrFailed || (stop >= 0 && match.index >= stop) || !plan) continue;
		if (!plan.has(name)) {
			const bare = name.split(":", 1)[0];
			// An unplanned unpack invalidates the denominator. Without native
			// evidence, a differently spelled setup could also be ambiguous.
			ambiguous ||=
				isUnpack ||
				(!nativeArch &&
					(bare === name
						? [...plan].some((candidate) => candidate.startsWith(`${name}:`))
						: bare !== undefined && plan.has(bare)));
		} else if (isUnpack) {
			unpacked.add(name);
		} else if (unpacked.has(name)) {
			configured.add(name);
		} else {
			// A setup for a planned package with no matching unpack cannot establish a count.
			ambiguous = true;
		}
	}
	// Retained stderr has no shared offset with stdout. Only a previously
	// published, verified install count can survive an error on that stream.
	if (stderrFailed && current.total > 0 && current.unpacking > 0)
		return current;
	const total =
		stderrFailed ||
		ambiguous ||
		((pinnedInstall || sawSetup || stop >= 0) && unpacked.size === 0)
			? 0
			: (plan?.size ?? 0);
	return {
		...current,
		total,
		downloading: unpacked.size > 0 ? total : Math.min(highestGet, total),
		unpacking: total > 0 ? unpacked.size : Number(observedUnpacks.size > 0),
		setting_up: total > 0 ? configured.size : Number(sawSetup),
	};
}
