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
 * Production dependency binding for `modem_shadow`.
 *
 * It exists as its own module for one reason: it is the ONLY file on the shadow
 * path that imports the D-Bus client at runtime, so `shadow.ts` can reach it
 * behind a lazy `import()` and a device with `modem_shadow` unset never loads
 * `@httptoolkit/dbus-native` at all. Same shape, same reason, as
 * `cellular-stack.ts`'s lazy `dbus-backend.ts` import.
 *
 * It deliberately does NOT wrap the transport in the audit layer — `startModemShadow`
 * does that, around whatever this returns. Wrapping here would leave the recording
 * fake a test injects sitting OUTSIDE the guard, and the mutation-freedom proof
 * would be asserting a property of a wrapper the production path does not use.
 */

import { createMmDbusObserver } from "@ceralive/modem-control";
import { createDbusTransport } from "@ceralive/modem-control/transport";

import { getModems } from "../modems/modems-state.ts";
import { resolveSystemBusAddress } from "./dbus-backend.ts";
import type { ShadowModeDeps } from "./shadow.ts";
import {
	collectShadowStates,
	mmcliModemToShadowState,
	type ShadowStateSet,
} from "./shadow-divergence.ts";

/** Snapshot the live mmcli side through the secret-dropping allowlist mapper. */
export function readMmcliShadowStates(): ShadowStateSet {
	return collectShadowStates(
		Object.values(getModems()),
		mmcliModemToShadowState,
	);
}

export function buildProductionShadowDeps(): ShadowModeDeps {
	return {
		createTransport: () =>
			createDbusTransport({ busAddress: resolveSystemBusAddress() }),
		createObserver: (transport) => createMmDbusObserver({ transport }),
		readMmcliStates: readMmcliShadowStates,
	};
}
