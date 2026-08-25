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
  THE terminal-frame seam for a hotspot start/stop, and the only place a
  `wifi` `hotspot.start` / `hotspot.stop` frame is built.

  WHY IT IS ITS OWN MODULE. The terminal outcome is produced by TWO layers that
  cannot see each other: the transaction publishes every refusal it can decide
  itself (missing adapter, capability refusal, a held lock, an NM error that was
  rolled back), while the bounded NM-confirmation poll — which resolves long
  after the RPC has replied — publishes the accepted case. Letting each build its
  own frame is how the two come to disagree about the shape a consumer keys on.

  WHY IT IS A BROADCAST. The confirmation settles with no requesting socket in
  hand (a monitor event or a backoff poll gets there first), so a frame addressed
  to the caller could not be produced at all on the one path that most needs one.
*/

import type { HotspotToggleError } from "@ceraui/rpc/schemas";

import { broadcastMsg } from "../ui/websocket-server.ts";

export type { HotspotToggleError };

export type HotspotToggleOutcome =
	| { success: true }
	| { success: false; error: HotspotToggleError };

export type HotspotOutcomeKind = "start" | "stop";

export type HotspotOutcomePublisher = (
	kind: HotspotOutcomeKind,
	device: number | string,
	outcome: HotspotToggleOutcome,
) => void;

export const publishHotspotOutcome: HotspotOutcomePublisher = (
	kind,
	device,
	outcome,
) => {
	broadcastMsg("wifi", {
		hotspot: {
			[kind]: outcome.success
				? { device, success: true }
				: { device, error: outcome.error },
		},
	});
};
