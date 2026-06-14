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
 * Device-control channel endpoint pinning (ADR-0006, spec §10).
 *
 * Platform authentication for the control channel has two halves: the device
 * authenticates the platform's TOKEN with PASETO v4.public ({@link ../pairing/device-token.ts}),
 * and the device authenticates the platform's IDENTITY by pinning the hub URL.
 *
 * Endpoint pinning is the second half: the device-control hub URL is provisioned
 * at image-build time and is NEVER operator-configurable. This is the deliberate
 * difference from the BCRPT relay host (`modules/remote/remote.ts`), which DOES
 * honour an operator-entered `custom_provider`. Reusing the relay's
 * operator-configurable provider for the control channel would let a malicious
 * or mis-set `custom_provider` redirect the channel — and the credentials it
 * presents — to an attacker-controlled host. The control channel therefore reads
 * ONLY the pinned source and ignores all operator provider config.
 *
 * Kept out of `remote.ts` on purpose: that module's relay logic must not be
 * touched, and importing it pulls the boot-time `setup.json` read into any test
 * that exercises pinning. This module has no such dependency.
 */

/**
 * Build-time pinned device-control hub URL. Provisioned into the device image
 * (like `PASETO_PUBLIC_KEY`); absent on a dev host that has no control channel.
 */
export const CONTROL_HUB_URL_ENV = "CERALIVE_CONTROL_HUB_URL";

export interface ControlChannelEndpoint {
	url: string;
	host: string;
	/** Always `true`: this endpoint is build-time pinned, not operator-set. */
	pinned: true;
}

/**
 * The operator-set provider config that steers the BCRPT relay host. Accepted by
 * {@link resolveControlChannelEndpoint} only to make explicit that it is IGNORED
 * for the control channel.
 */
export interface OperatorProviderConfig {
	custom_provider?: { host?: string } & Record<string, unknown>;
	remote_provider?: string;
}

/**
 * Resolve the device-control channel hub endpoint from the build-time pinned
 * source ONLY. `operatorConfig` (`custom_provider` / `remote_provider`) is
 * deliberately ignored — it cannot redirect this channel. Throws when the pin is
 * missing or malformed (fail-closed: never silently fall back to an unpinned or
 * operator-supplied host).
 */
export function resolveControlChannelEndpoint(
	_operatorConfig?: OperatorProviderConfig,
	env: Record<string, string | undefined> = process.env,
): ControlChannelEndpoint {
	const pinned = env[CONTROL_HUB_URL_ENV]?.trim();
	if (!pinned) {
		throw new Error(
			`${CONTROL_HUB_URL_ENV} is not provisioned: the device-control channel requires a build-time pinned hub URL (ADR-0006 / remote-relay-support spec §10 endpoint pinning).`,
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(pinned);
	} catch {
		throw new Error(
			`${CONTROL_HUB_URL_ENV} is not a valid URL: ${JSON.stringify(pinned)}`,
		);
	}
	if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
		throw new Error(
			`${CONTROL_HUB_URL_ENV} must be a ws:// or wss:// URL, got ${parsed.protocol}`,
		);
	}

	return { url: pinned, host: parsed.host, pinned: true };
}
