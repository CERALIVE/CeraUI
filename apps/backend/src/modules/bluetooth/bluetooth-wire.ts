/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The Bluetooth WIRE projection — registry rows → `@ceraui/rpc` shapes.
 *
 * PURE: no bus, no spawn, no clock. It is the Bluetooth twin of
 * `modules/modems/modem-wire-projection.ts`, and it exists for the same reason:
 * the stack's interior state is shaped for the fold, and the wire is shaped for
 * a consumer that merges — so the translation belongs in ONE named place rather
 * than inline in a procedure handler where a second copy could appear.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A RECOVERABLE FIELD IS PUBLISHED EXPLICITLY, ALWAYS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `paired` / `trusted` / `connected` / `blocked` are emitted on every row, never
 * present-only-when-true: a device unpairs, disconnects and unblocks, and a
 * consumer that preserves an omitted optional field can raise such a flag and
 * never lower it (the `policy_route_missing` latch). `battery` and `rssi` are
 * the opposite case — absent means the device exposes no battery service / is
 * not advertising, and a zero would read as a measured reading.
 */

import type {
	BluetoothAdapter,
	BluetoothCapabilityClaims,
	BluetoothDevice,
	BluetoothStatus,
	BluetoothTransport,
} from "@ceraui/rpc/schemas";
import { resolveSupportClaim } from "@ceraui/rpc/schemas";

import { isPlaybackOnly } from "./bluetooth-classes.ts";
import type {
	BluetoothAdapterRow,
	BluetoothDeviceRow,
} from "./bluetooth-registry.ts";
import type { BluetoothStackState } from "./bluetooth-stack.ts";

/**
 * The link transport, from POSITIVE evidence only.
 *
 * Every profile the class model knows — HFP/HSP (`scoCapable`), A2DP source
 * (`audio-input`) and A2DP sink (`isPlaybackOnly`) — is BR/EDR-only, so any of
 * them PROVES BR/EDR. Nothing on a registry row proves LE: BlueZ's
 * `AddressType` is not folded, and an empty UUID list is a statement about what
 * BlueZ has resolved rather than about the radio. So a device that proves
 * nothing answers `unknown` instead of being guessed into a bucket an operator
 * would then act on.
 *
 * It deliberately reuses `bluetooth-classes.ts` rather than carrying a second
 * UUID table — two tables for one question drift, and the class model is where
 * that knowledge already lives.
 */
export function deriveBluetoothTransport(
	row: BluetoothDeviceRow,
): BluetoothTransport {
	if (row.scoCapable) return "bredr";
	if (row.deviceClass === "audio-input") return "bredr";
	if (isPlaybackOnly(row.uuids)) return "bredr";
	return "unknown";
}

export function projectBluetoothDevice(
	row: BluetoothDeviceRow,
): BluetoothDevice {
	return {
		path: row.path,
		...(row.adapterPath !== undefined ? { adapterPath: row.adapterPath } : {}),
		...(row.address !== undefined ? { address: row.address } : {}),
		...(row.name !== undefined ? { name: row.name } : {}),
		deviceClass: row.deviceClass,
		transport: deriveBluetoothTransport(row),
		paired: row.paired,
		trusted: row.trusted,
		connected: row.connected,
		blocked: row.blocked,
		scoCapable: row.scoCapable,
		...(row.batteryPercentage !== undefined
			? { battery: row.batteryPercentage }
			: {}),
		...(row.rssi !== undefined ? { rssi: row.rssi } : {}),
		...(row.pending !== undefined ? { pending: row.pending } : {}),
	};
}

export function projectBluetoothAdapter(
	row: BluetoothAdapterRow,
): BluetoothAdapter {
	return {
		path: row.path,
		...(row.address !== undefined ? { address: row.address } : {}),
		...(row.name !== undefined ? { name: row.name } : {}),
		powered: row.powered,
		discovering: row.discovering,
		discoverable: row.discoverable,
		pairable: row.pairable,
		...(row.pending !== undefined ? { pending: row.pending } : {}),
	};
}

/**
 * The FIVE-STATE claims, resolved through the SHARED `resolveSupportClaim`.
 *
 * Bluetooth is deliberately NOT a `CAPABILITY_MODULE` (that enum is closed,
 * modem-only and default-OFF-forever — registering it there would make the whole
 * surface invisible by design), so it brings its own feature registry and reuses
 * the ladder. The gate is the OPERATOR PREFERENCE: Bluetooth switched off is
 * exactly "shipped, gate off" ⇒ `implemented`.
 *
 * `certified` is `false` for every feature, and that is a statement rather than
 * a placeholder: certification means a reviewed evidence bundle for this exact
 * board, and no Bluetooth drill has been run on hardware. `capable` is therefore
 * the ceiling today — which is the floor for OFFERING a control, so nothing is
 * withheld by it.
 */
export function resolveBluetoothCapabilityClaims(
	state: BluetoothStackState,
): BluetoothCapabilityClaims {
	const gateEnabled = state.enabled;
	const noAdapter = state.unavailable?.cause === "no_adapter";

	// A controller we are OBSERVING is proof; BlueZ answering with zero
	// `Adapter1` objects is proof of the opposite. Anything else — a stack that
	// never started, a bus we could not reach — is a statement about the READ.
	const adapterEvidence =
		state.adapters.length > 0 ? "present" : noAdapter ? "absent" : "unknown";

	// `exporter_unavailable` is this BUILD saying it ships no D-Bus object
	// server, which is a positive absence rather than an unread capability — so
	// it resolves `unavailable` and the surface can say so instead of letting an
	// operator discover it from a pairing that never completes.
	const pairingEvidence = state.agent.registered
		? "present"
		: state.agent.reason === "exporter_unavailable"
			? "absent"
			: "unknown";

	// An absent audio device is not proof the board cannot do audio input — it
	// is proof nothing is paired yet — so it stays `unknown`, never `absent`.
	const audioEvidence = state.devices.some(
		(d) => d.deviceClass === "audio-input",
	)
		? "present"
		: "unknown";

	const batteryEvidence = state.devices.some(
		(d) => d.batteryPercentage !== undefined,
	)
		? "present"
		: "unknown";

	return {
		adapter: resolveSupportClaim({
			implemented: true,
			gateEnabled,
			capability: adapterEvidence,
			certified: false,
		}),
		pairing: resolveSupportClaim({
			implemented: true,
			gateEnabled,
			capability: pairingEvidence,
			certified: false,
		}),
		"audio-input": resolveSupportClaim({
			implemented: true,
			gateEnabled,
			capability: audioEvidence,
			certified: false,
		}),
		battery: resolveSupportClaim({
			implemented: true,
			gateEnabled,
			capability: batteryEvidence,
			certified: false,
		}),
	};
}

/** The whole `bluetooth` wire payload, from one stack state snapshot. */
export function buildBluetoothStatus(
	state: BluetoothStackState,
): BluetoothStatus {
	return {
		available: state.available,
		enabled: state.enabled,
		...(state.unavailable !== undefined
			? {
					unavailable: {
						cause: state.unavailable.cause,
						...(state.unavailable.detail !== undefined
							? { detail: state.unavailable.detail }
							: {}),
					},
				}
			: {}),
		adapters: state.adapters.map(projectBluetoothAdapter),
		devices: state.devices.map(projectBluetoothDevice),
		agent: {
			registered: state.agent.registered,
			isDefaultAgent: state.agent.isDefaultAgent,
			...(state.agent.reason !== undefined
				? { reason: state.agent.reason }
				: {}),
		},
		bootReconnectDone: state.bootReconnectDone,
		capabilities: resolveBluetoothCapabilityClaims(state),
	};
}
