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

import { type SharingDiag, sharingDiagSchema } from "@ceraui/rpc/schemas";

import { broadcastMsg } from "../../ui/websocket-server.ts";

export const SHARING_DIAG_EVENT = "sharing_diag" as const;

/*
 * The pre-check state is every check EXPLICITLY `unknown`, never `ok`.
 *
 * A dev/emulated host is gated out of the reader entirely and a real device has
 * not run its first pass at boot, so this value is what a freshly authenticated
 * client receives — and it must say "nothing has been established" rather than
 * claim a healthy coexistence nobody looked at.
 */
const UNCHECKED: SharingDiag = {
	state: "unknown",
	checkedAt: 0,
	firewallBackend: { state: "unknown" },
	steeringRules: { state: "unknown" },
	sharedNat: { state: "unknown" },
	foreignTables: { state: "unknown" },
};

let status: SharingDiag = UNCHECKED;
let statusKey = JSON.stringify(status);

export function getSharingDiag(): SharingDiag {
	return status;
}

/**
 * Publish a fresh verdict, on change only.
 *
 * `checkedAt` is deliberately EXCLUDED from the change key: it moves on every
 * pass, so including it would broadcast an identical verdict on every tick.
 */
export function publishSharingDiag(next: SharingDiag): void {
	const parsed = sharingDiagSchema.parse(next);
	const key = JSON.stringify({ ...parsed, checkedAt: 0 });
	status = parsed;
	if (key === statusKey) return;
	statusKey = key;
	broadcastMsg(SHARING_DIAG_EVENT, status);
}

export function resetSharingDiagForTest(): void {
	status = UNCHECKED;
	statusKey = JSON.stringify(status);
}
