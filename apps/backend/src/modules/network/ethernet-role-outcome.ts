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
  THE only builder of an `eth_role` frame.

  It exists for the reason `wifi-adapter-mode-outcome.ts` exists: a role change
  resolves in places that cannot see each other — the transition refuses what it
  can decide itself, while the boot reconciler settles long after any RPC — and
  two builders is how those come to disagree about the shape a consumer keys on.

  It is a BROADCAST because the reconciler settles with no requesting socket in
  hand.
*/

import type { EthernetRole, EthernetRoleError } from "@ceraui/rpc/schemas";

import { broadcastMsg } from "../ui/websocket-server.ts";

export const ETHERNET_ROLE_MESSAGE = "eth_role";

export type EthernetRoleOutcome =
	| { pending: true; role: EthernetRole }
	| { success: true; role: EthernetRole }
	| { success: false; error: EthernetRoleError };

export type EthernetRoleOutcomePublisher = (
	name: string,
	outcome: EthernetRoleOutcome,
) => void;

export const publishEthernetRoleOutcome: EthernetRoleOutcomePublisher = (
	name,
	outcome,
) => {
	broadcastMsg(ETHERNET_ROLE_MESSAGE, {
		eth_role:
			"pending" in outcome
				? { name, role: outcome.role, pending: true }
				: outcome.success
					? { name, role: outcome.role, success: true }
					: { name, error: outcome.error },
	});
};
