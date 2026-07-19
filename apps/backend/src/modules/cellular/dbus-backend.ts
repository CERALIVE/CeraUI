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
 * Production dbus cellular backend — a thin adapter over the
 * `@ceralive/modem-control` epoch-scoped ModemManager D-Bus observer.
 *
 * `start()` connects the system bus and resolves the first authoritative
 * snapshot (the composition root's commit point). With no reachable bus
 * (dev / CI / no hardware) `start()` rejects, so the composition root falls back
 * to mmcli with degraded readiness. Lazily imported by `cellular-stack.ts` only
 * when the dbus backend is selected, so the D-Bus transport never loads on the
 * default mmcli path.
 *
 * Phase B foundation only: the observer's ongoing snapshot stream is consumed by
 * a later todo (shadow mode). This wave commits the seam + the registry dep.
 */

import { createMmDbusObserver } from "@ceralive/modem-control";
import { createDbusTransport } from "@ceralive/modem-control/transport";

import type { CellularBackend, CellularStartResult } from "./cellular-stack.ts";

const SYSTEM_BUS_ADDRESS = "unix:path=/var/run/dbus/system_bus_socket";

export function createDbusCellularBackend(): CellularBackend {
	const transport = createDbusTransport({
		busAddress: process.env.DBUS_SYSTEM_BUS_ADDRESS ?? SYSTEM_BUS_ADDRESS,
	});
	const observer = createMmDbusObserver({ transport });

	return {
		async start(): Promise<CellularStartResult> {
			const list = await observer.start();
			return { ok: list.ok };
		},
		stop: () => observer.stop(),
	};
}
