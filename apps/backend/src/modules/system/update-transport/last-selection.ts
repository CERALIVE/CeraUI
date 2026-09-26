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
 * an absence the surface renders as "no transfer has been attempted yet", never
 * as a healthy default.
 *
 * Scope, stated so it is not overread: today only the OS agent routes through
 * the selector (the package path still uses its legacy apt-reachability
 * preflight, whose own per-family verdict rides `update_state.reachability`).
 * The selector itself is fixture/netns-proven; live verification against the
 * deployed origins is deferred with Todo 12.
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

export function recordTransportSelection(
	profile: "apt" | "os",
	selection: TransportSelection,
	now: number = Date.now(),
): void {
	lastSelection = summarizeTransportSelection(profile, selection, now);
}

export function getLastTransportSelection():
	| UpdateTransportSummary
	| undefined {
	return lastSelection;
}

export function resetLastTransportSelectionForTest(): void {
	lastSelection = undefined;
}
