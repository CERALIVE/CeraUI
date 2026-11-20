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

/*
  THE pending/terminal-frame seam for a per-adapter mode change, and the only
  place a `wifi` -> `adapter_mode` frame is built.

  It exists for the reason `wifi-hotspot-outcome.ts` exists, one layer up: a mode
  change resolves in TWO places that cannot see each other — the transition
  refuses what it can decide itself, while a target that reaches NetworkManager
  settles from the bounded AP confirmation long after the RPC has replied. Two
  builders is how those two come to disagree about the shape a consumer keys on.

  It is a BROADCAST for the same reason: the confirmation settles with no
  requesting socket in hand.
*/

import type {
	WifiAdapterMode,
	WifiAdapterModeError,
	WifiAdapterModeResult,
} from "@ceraui/rpc/schemas";

import { broadcastMsg } from "../ui/websocket-server.ts";
import { withoutWifiRequestBinding } from "./wifi-binding.ts";
import { getWifiFrameIncarnation } from "./wifi-frame-incarnation.ts";

export type AdapterModeOutcome =
	| { pending: true; mode: WifiAdapterMode }
	| { success: true; mode: WifiAdapterMode }
	| { success: false; error: WifiAdapterModeError; reason?: string };

export type AdapterModeOutcomePublisher = (
	device: number | string,
	outcome: AdapterModeOutcome,
	reply?: AdapterModeRefusalPublisher,
) => void;

export type AdapterModeRefusalPublisher = (
	device: number | string,
	outcome: Extract<AdapterModeOutcome, { success: false }>,
) => void;

export function buildAdapterModeOutcome(
	device: number | string,
	outcome: AdapterModeOutcome,
): WifiAdapterModeResult {
	return {
		...("pending" in outcome
			? { device, mode: outcome.mode, pending: true as const }
			: outcome.success
				? { device, mode: outcome.mode, success: true }
				: {
						device,
						error: outcome.error,
						...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
					}),
		...getWifiFrameIncarnation(),
	};
}

export const publishAdapterModeOutcome: AdapterModeOutcomePublisher = (
	device,
	outcome,
	reply,
) =>
	withoutWifiRequestBinding(() => {
		if (reply && "success" in outcome && !outcome.success) {
			reply(device, outcome);
			return;
		}
		broadcastMsg("wifi", {
			adapter_mode: buildAdapterModeOutcome(device, outcome),
		});
	});
