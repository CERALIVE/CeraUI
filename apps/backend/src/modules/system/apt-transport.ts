import type { AptFamilyProbe } from "@ceraui/rpc";
import { logger } from "../../helpers/logger.ts";
import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";
import type { AptReachability } from "./apt-reachability.ts";
import { trackAptTransfer } from "./apt-transfer-abort.ts";
import type {
	Family,
	ProbeState,
	TransportSelection,
} from "./update-transport/core.ts";
import { selectUpdateTransport } from "./update-transport/executor.ts";
import {
	UpdatePinError,
	UpdateTransferError,
	updatePinController,
} from "./update-transport/pin.ts";

type Verdict = AptReachability["verdict"];
/** One networked apt run; `reachability.verdict` is this attempt's pinned family. */
export type AptStep = (
	reachability: AptReachability,
	signal?: AbortSignal,
) => Promise<SpawnWithTimeoutResult>;

/**
 * One APT transaction's network authority. A legacy transaction is today's
 * unbound family verdict; a pinned one routes the `apt_uid` sandbox user
 * (apt's fetch methods) through the selected uplink and family.
 */
export type AptTransaction = {
	readonly pinned: boolean;
	readonly reachability: AptReachability;
	/** Local apt work under the winner's rule; `refused` answers a routing refusal. */
	readonly within: <T>(work: () => Promise<T>, refused: () => T) => Promise<T>;
	/** A networked apt run; an apt fetch failure fails over to the next pair. */
	readonly transfer: (
		step: AptStep,
		options?: { readonly abortable?: boolean },
	) => Promise<SpawnWithTimeoutResult>;
	readonly aborted: () => boolean;
};

class AptTransferAborted extends Error {
	constructor() {
		super("apt transfer aborted for a stream start");
		this.name = "AptTransferAborted";
	}
}

export type AptTransportDeps = {
	readonly select: () => Promise<TransportSelection>;
	readonly pin: Pick<typeof updatePinController, "run">;
};

let overrides: Partial<AptTransportDeps> = {};

export function setAptTransportDepsForTest(
	next: Partial<AptTransportDeps> | null,
): void {
	overrides = next ?? {};
}

// Resolved per call: reading `updatePinController` at module load trips an import cycle.
const pinController = () => overrides.pin ?? updatePinController;
const select = () =>
	overrides.select?.() ??
	// The APT profile never names an images.ceralive.tv object, so board and channel are inert.
	selectUpdateTransport({ profile: "apt", board: "apt", channel: "stable" });

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
const familyName = (family: Family) => (family === 4 ? "ipv4" : "ipv6");
const forced = (family: Family): Verdict =>
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

/** Fold a ranked selection into the verdict the existing APT gates read. */
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

/** Only apt's own fetch failure on this pair may move the transaction to the next one. */
export function classifyAptFetchFailure(
	result: SpawnWithTimeoutResult,
): UpdateTransferError["reason"] | undefined {
	if (
		!/(?:^|\n)[EW]: (?:Failed to fetch|Some index files failed)/.test(
			result.stderr,
		)
	)
		return undefined;
	return FETCH_FAILURES.find(([pattern]) => pattern.test(result.stderr))?.[1];
}

const refusedRun = (error: Error): SpawnWithTimeoutResult => ({
	exitCode: 1,
	stdout: "",
	stderr: error.message,
});

function isRoutingRefusal(error: unknown): error is Error {
	return (
		error instanceof UpdatePinError ||
		error instanceof AggregateError ||
		error instanceof AptTransferAborted
	);
}

export function legacyAptTransaction(
	reachability: AptReachability,
): AptTransaction {
	return {
		pinned: false,
		reachability,
		within: (work) => work(),
		transfer: (step) => step(reachability),
		aborted: () => false,
	};
}

/** Probe every (uplink, family), then pin each apt run to the ranked winner. */
export async function openPinnedAptTransaction(): Promise<AptTransaction> {
	let selection: TransportSelection;
	try {
		selection = await select();
	} catch (error) {
		logger.warn("APT transport selection failed", { error });
		return legacyAptTransaction({
			ipv4: "probe_unavailable",
			ipv6: "probe_unavailable",
			used: "none",
			verdict: "probe_unavailable",
			detail: [],
		});
	}
	const controller = new AbortController();
	const cancelled = () => {
		if (controller.signal.aborted) throw new AptTransferAborted();
	};
	const reachability = reachabilityFromSelection(selection);
	return {
		pinned: true,
		reachability,
		aborted: () => controller.signal.aborted,
		async within(work, refused) {
			// With no winner the verdict already refuses every networked step; local work stays local.
			if (selection.status === "none") return work();
			try {
				// Box the outcome so an arbitrary coded error is never mistaken for a transfer failure.
				const boxed = await pinController().run("apt", selection, async () => {
					try {
						return { ok: true as const, value: await work() };
					} catch (error) {
						return { ok: false as const, error };
					}
				});
				if (!boxed.ok) throw boxed.error;
				return boxed.value;
			} catch (error) {
				if (!isRoutingRefusal(error)) throw error;
				logger.warn("APT transaction refused by update routing", { error });
				return refused();
			}
		},
		async transfer(step, options = {}) {
			let last: SpawnWithTimeoutResult | undefined;
			const release = options.abortable
				? trackAptTransfer(controller)
				: () => undefined;
			try {
				return await pinController().run(
					"apt",
					selection,
					async ({ family }) => {
						last = await step(
							{
								...reachability,
								verdict: forced(family),
								used: familyName(family),
							},
							options.abortable ? controller.signal : undefined,
						);
						const reason = classifyAptFetchFailure(last);
						if (reason) throw new UpdateTransferError(reason);
						return last;
					},
					{ checkCancelled: cancelled },
				);
			} catch (error) {
				if (error instanceof UpdateTransferError && last) return last;
				if (!isRoutingRefusal(error)) throw error;
				logger.warn("APT transfer refused by update routing", { error });
				return refusedRun(error);
			} finally {
				release();
			}
		},
	};
}
