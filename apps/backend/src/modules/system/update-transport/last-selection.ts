/**
 * The most recent update-transport selection, kept so the Updates dialog's
 * Connection section can say which uplink and address family the device last
 * chose for an update transfer, and what it found on the candidates it passed
 * over (captive portals above all).
 *
 * It is an OBSERVATION RECORD, never an input: nothing reads it to decide a
 * route. `selectUpdateTransport()` is the only writer, so the record is exactly
 * as fresh as the last real selection and carries its own `checkedAt`. Before
 * any selection has run it is `undefined`, which the RPC projects as `null` —
 * an unknown history after a process restart, never proof of no past transfer
 * or a healthy default.
 *
 * Each profile retains its own latest observation: a combined manual check
 * selects APT before OS, and the OS result must not erase package failures.
 * Images without transport-uidrange keep the legacy APT reachability preflight.
 */
import type {
	UpdateTransportFinding,
	UpdateTransportSummary,
} from "@ceraui/rpc/schemas";

import type { ProbeState, TransportSelection } from "./core.ts";

const CAPTIVE_STATES: ReadonlySet<ProbeState> = new Set([
	"captive-http",
	"captive-tls",
]);

/** Pure projection of a ranked selection onto the wire summary. */
export function summarizeTransportSelection(
	profile: "apt" | "os",
	selection: TransportSelection,
	checkedAt: number,
): UpdateTransportSummary {
	const findings: UpdateTransportFinding[] = selection.ranked.map((row) => {
		const states = [
			...new Set(
				row.hosts
					.map((host) => host.state)
					.filter((state): state is ProbeState => state !== "clear"),
			),
		];
		return {
			ifname: row.candidate.ifname,
			kind: row.candidate.kind,
			family: row.family,
			metered: row.candidate.metered,
			healthy: row.healthy,
			captive: states.some((state) => CAPTIVE_STATES.has(state)),
			states,
			hosts: [
				...new Map(
					row.hosts
						.filter(({ state }) => state !== "clear")
						.map(({ host, state }) => [`${host}\0${state}`, { host, state }]),
				).values(),
			].slice(0, 16),
		};
	});
	return {
		profile,
		checkedAt,
		status: selection.status,
		selected:
			selection.status === "selected"
				? {
						ifname: selection.selected.candidate.ifname,
						kind: selection.selected.candidate.kind,
						family: selection.selected.family,
						metered: selection.selected.candidate.metered,
					}
				: null,
		findings,
	};
}

let lastSelection: UpdateTransportSummary | undefined;
const lastByProfile = new Map<"apt" | "os", UpdateTransportSummary>();

export function recordTransportSelection(
	profile: "apt" | "os",
	selection: TransportSelection,
	now: number = Date.now(),
): void {
	lastSelection = summarizeTransportSelection(profile, selection, now);
	lastByProfile.set(profile, lastSelection);
}

export function getLastTransportSelection():
	| UpdateTransportSummary
	| undefined {
	return lastSelection;
}

export function getLastTransportSelectionForProfile(
	profile: "apt" | "os",
): UpdateTransportSummary | undefined {
	return lastByProfile.get(profile);
}

export function resetLastTransportSelectionForTest(): void {
	lastSelection = undefined;
	lastByProfile.clear();
}
