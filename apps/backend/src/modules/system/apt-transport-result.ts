import type { AptFamilyProbe } from "@ceraui/rpc";
import {
	SpawnAbortError,
	SpawnTimeoutError,
} from "../../helpers/bounded-spawn.ts";
import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";
import type { AptReachability } from "./apt-reachability.ts";
import type {
	Family,
	ProbeState,
	TransportSelection,
} from "./update-transport/core.ts";
import type { UpdateTransferError } from "./update-transport/pin.ts";

type Verdict = AptReachability["verdict"];
export function installFamily(
	verdict: Verdict,
): "any" | "force_ipv4" | "force_ipv6" {
	return verdict === "force_ipv4"
		? "force_ipv4"
		: verdict === "force_ipv6"
			? "force_ipv6"
			: "any";
}
const failures = new WeakMap<SpawnWithTimeoutResult, SpawnTimeoutError>();

export function normalizeAptCommandFailure(
	error: unknown,
): SpawnWithTimeoutResult {
	const result = {
		exitCode: 1,
		stdout: "",
		stderr: error instanceof Error ? error.message : String(error),
	};
	if (error instanceof SpawnTimeoutError) failures.set(result, error);
	return result;
}

export const aptCommandFailure = (
	result: SpawnWithTimeoutResult,
): SpawnTimeoutError | undefined => failures.get(result);
const FAMILY_PROBE: Record<ProbeState, AptFamilyProbe> = {
	clear: "ok",
	"captive-http": "captive",
	"captive-tls": "captive",
	"tls-error": "blocked",
	tampered: "unknown",
	blocked: "blocked",
	"no-route": "no_route",
	"dns-failed": "dns_failed",
	"credentials-invalid": "credentials_invalid",
	"probe-unavailable": "probe_unavailable",
};
const PRECEDENCE = [
	"probe_unavailable",
	"credentials_invalid",
	"captive",
] as const;
const REFUSAL: Record<(typeof PRECEDENCE)[number], Verdict> = {
	probe_unavailable: "probe_unavailable",
	credentials_invalid: "credentials_invalid",
	captive: "captive_portal",
};
export const familyName = (family: Family) => (family === 4 ? "ipv4" : "ipv6");
export const forced = (family: Family): Verdict =>
	family === 4 ? "force_ipv4" : "force_ipv6";

function foldFamily(
	selection: TransportSelection,
	family: Family,
): AptFamilyProbe {
	const rows = selection.ranked.filter((row) => row.family === family);
	if (rows.some((row) => row.healthy)) return "ok";
	const states = rows.flatMap((row) =>
		row.hosts.map(({ state }) => FAMILY_PROBE[state]).filter((s) => s !== "ok"),
	);
	return PRECEDENCE.find((s) => states.includes(s)) ?? states[0] ?? "unknown";
}

export function reachabilityFromSelection(
	selection: TransportSelection,
): AptReachability {
	const ipv4 = foldFamily(selection, 4);
	const ipv6 = foldFamily(selection, 6);
	const winner =
		selection.status === "selected" ? selection.selected.family : undefined;
	const refusal = PRECEDENCE.find((s) => ipv4 === s || ipv6 === s);
	return {
		ipv4,
		ipv6,
		used: winner === undefined ? "none" : familyName(winner),
		verdict:
			winner !== undefined
				? forced(winner)
				: refusal
					? REFUSAL[refusal]
					: "unreachable",
		detail: selection.ranked.flatMap((row) =>
			row.hosts
				.filter(({ state }) => state !== "clear")
				.map(({ host, state }) => ({
					origin: host,
					family: familyName(row.family),
					result: FAMILY_PROBE[state],
				})),
		),
	};
}

const FETCH_FAILURES: readonly [RegExp, UpdateTransferError["reason"]][] = [
	[/Temporary failure resolving|Could not resolve/, "dns-failed"],
	[/Certificate verification failed|Could not handshake|TLS/, "tls-error"],
	[
		/timed out|Connection failed|does the network require authentication/,
		"blocked",
	],
	[
		/Could not connect|Unable to connect|unreachable|No route to host/,
		"no-route",
	],
];
export function classifyAptFetchFailure(
	result: SpawnWithTimeoutResult,
): UpdateTransferError["reason"] | undefined {
	const failure = aptCommandFailure(result);
	if (failure instanceof SpawnAbortError) return undefined;
	if (failure instanceof SpawnTimeoutError) return "blocked";
	if (
		!/(?:^|\n)[EW]: (?:Failed to fetch|Some index files failed)/.test(
			result.stderr,
		)
	)
		return undefined;
	return FETCH_FAILURES.find(([pattern]) => pattern.test(result.stderr))?.[1];
}
