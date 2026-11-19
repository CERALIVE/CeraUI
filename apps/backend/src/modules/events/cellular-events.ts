import { deriveModemStableKey } from "@ceraui/rpc/schemas";
import { getModemIdPath } from "../modems/modem-wire-producer.ts";
import type { SimPresence } from "../modems/sim-presence.ts";
import {
	getModemsState,
	onModemsChange,
} from "../modems/state/modems-state-cache.ts";
import { emitEvent } from "./emit.ts";

type SeenModem = {
	readonly name: string;
	readonly connection: string | undefined;
	readonly rejection: string | null | undefined;
	readonly simPresence: Exclude<SimPresence, "unknown"> | undefined;
};

let unsubscribe: (() => void) | undefined;

/** Observe the existing snapshots; numeric modem IDs are never identities. */
export function initCellularEvents(): () => void {
	if (unsubscribe) return unsubscribe;
	let previous = new Map<string, SeenModem>();
	const pending: Array<() => void> = [];
	let emitting = false;

	const observe = (): void => {
		const next = new Map<string, SeenModem>();
		for (const modem of Object.values(getModemsState())) {
			const modemKey = deriveModemStableKey(getModemIdPath(modem.ifname));
			if (modemKey === undefined) continue;
			const seen = previous.get(modemKey);
			const name = modem.name;
			const status = modem.status;
			const state = status?.connection;
			const connection =
				state && state !== "unknown" ? state : seen?.connection;
			// A missing status is unreadable; a readable status without a token is clear.
			const rejection = status
				? (status.registration_rejection?.error ?? null)
				: seen?.rejection;
			const simPresence =
				modem.sim_presence === "unknown"
					? seen?.simPresence
					: (modem.sim_presence ?? seen?.simPresence);
			next.set(modemKey, {
				name,
				connection,
				rejection,
				simPresence,
			});
			if (!seen) {
				pending.push(() => emitEvent("modem_added", { modemKey, name }));
				continue;
			}
			if (
				seen.connection !== undefined &&
				connection !== seen.connection &&
				status
			) {
				if (connection === "connected") {
					const { network_type: networkType, roaming } = status;
					pending.push(() =>
						emitEvent("modem_connected", { modemKey, networkType, roaming }),
					);
				} else if (seen.connection === "connected") {
					pending.push(() => emitEvent("modem_disconnected", { modemKey }));
				}
			}
			if (
				seen.rejection !== undefined &&
				typeof rejection === "string" &&
				rejection !== seen.rejection
			) {
				pending.push(() =>
					emitEvent("modem_registration_rejected", { modemKey, rejection }),
				);
			}
			if (seen.simPresence !== undefined && simPresence !== seen.simPresence) {
				pending.push(() =>
					emitEvent(
						simPresence === "present" ? "sim_inserted" : "sim_removed",
						{
							modemKey,
						},
					),
				);
			}
		}
		for (const [modemKey, seen] of previous) {
			if (!next.has(modemKey)) {
				pending.push(() =>
					emitEvent("modem_removed", { modemKey, name: seen.name }),
				);
			}
		}
		previous = next;
		if (emitting) return;
		emitting = true;
		try {
			for (const emit of pending) {
				try {
					emit();
				} catch {
					// Diagnostics must not interrupt cellular snapshot delivery.
				}
			}
		} finally {
			pending.length = 0;
			emitting = false;
		}
	};

	const stop = onModemsChange(observe);
	unsubscribe = () => {
		stop();
		unsubscribe = undefined;
	};
	observe();
	return unsubscribe;
}
