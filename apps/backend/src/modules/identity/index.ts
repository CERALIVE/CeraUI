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
 * Device identity — the explicit init-time boot step (remote-relay-support spec
 * §9). initIdentity() loads `device_id` + `remote_key` from runtime config,
 * derives the paired state, and parks the result in module state so the control
 * channel can gate on it via getIdentity()/canDialControlChannel().
 *
 * Fail-soft, like the capabilities fallback ladder (MINIMAL_SAFE_CAPABILITIES):
 * a missing or unreadable identity NEVER throws and NEVER blocks boot — it
 * resolves to the unpaired floor and the device surfaces re-pairing locally.
 *
 * Per spec §9 the control channel MUST NOT dial until identity is resolved —
 * i.e. paired AND a `device_id` is available — so the hub can route a known
 * device. canDialControlChannel() encodes exactly that gate.
 */

import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import { getConfig } from "../config.ts";

export interface DeviceIdentity {
	deviceId: string | undefined;
	paired: boolean;
}

export const UNPAIRED_IDENTITY: DeviceIdentity = {
	deviceId: undefined,
	paired: false,
};

export interface IdentityLogger {
	info: (message: string, meta?: unknown) => void;
	warn: (message: string, meta?: unknown) => void;
}

export interface IdentityServiceDeps {
	readConfig: () => Pick<RuntimeConfig, "device_id" | "remote_key">;
	logger: IdentityLogger;
}

function defaultDeps(): IdentityServiceDeps {
	return {
		readConfig: () => getConfig(),
		logger,
	};
}

let currentIdentity: DeviceIdentity = UNPAIRED_IDENTITY;

export function getIdentity(): DeviceIdentity {
	return currentIdentity;
}

export function canDialControlChannel(): boolean {
	return currentIdentity.paired && currentIdentity.deviceId !== undefined;
}

export async function initIdentity(
	overrides: Partial<IdentityServiceDeps> = {},
): Promise<DeviceIdentity> {
	const deps: IdentityServiceDeps = { ...defaultDeps(), ...overrides };

	try {
		const config = deps.readConfig();
		const paired = config.remote_key !== undefined;
		const deviceId = paired ? config.device_id : undefined;

		currentIdentity = { deviceId, paired };

		if (!paired) {
			deps.logger.info("identity: device unpaired; control channel disabled");
		} else if (deviceId === undefined) {
			deps.logger.warn(
				"identity: paired but device_id missing; control channel stays closed until identity resolves",
			);
		} else {
			deps.logger.info("identity: device paired; control channel gate open");
		}

		return currentIdentity;
	} catch (err) {
		// Fail-soft (spec §9): an unreadable/unexpected config must never block
		// boot. Fall back to the unpaired floor; re-pairing is surfaced locally.
		deps.logger.warn(
			`identity: resolution failed, falling back to unpaired: ${err}`,
		);
		currentIdentity = UNPAIRED_IDENTITY;
		return currentIdentity;
	}
}
