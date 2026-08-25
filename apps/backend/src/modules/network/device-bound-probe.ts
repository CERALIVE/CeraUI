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
  A connectivity probe pinned to ONE PHYSICAL INTERFACE.

  WHY A SECOND PROBE EXISTS AT ALL. `internet.ts`'s bound probe steers by SOURCE
  ADDRESS, which is the one thing the duplicate-IP HiLink twins make ambiguous:
  the bench pair ships one factory MAC and BOTH lease `192.168.8.100`, so
  `localAddress: "192.168.8.100"` names a pair rather than a device and the
  kernel picks whichever route it likes. Worse, both twins' embedded admin
  gateway is the SAME address (`192.168.8.1`), so a DESTINATION address cannot
  separate them either. The only thing that can is `SO_BINDTODEVICE`, which
  Bun's `fetch` and `node:http` both lack — and which `curl --interface` has.

  That is the same reason `router-cellular-admin.ts` shells out to curl (proven
  on the bench: the same request bound to each twin returned two DIFFERENT
  serials), so this is that established pattern applied to the WAN question
  rather than a second mechanism.

  WHAT IT DOES **NOT** PROVE. Reaching the dongle's own admin API says nothing
  about the Internet — a SIM-less HiLink answers its LAN gateway happily and
  captive-portals everything else (board-measured: `apt-get` fetching the
  dongle's error page). So this probe targets ONLY the externally-resolved
  connectivity-check address and asserts the exact `204` + empty body contract
  `internet.ts` uses. Admin reachability and WAN truth are separate assertions
  and neither may stand in for the other.

  FAIL-SOFT. A missing/failing `curl` resolves `false` — the twin simply does not
  win the election, which is byte-identical to the behaviour before dup-IP
  interfaces were probeable at all. It never throws into the gateway loop.
*/

import { logger } from "../../helpers/logger.ts";
import {
	type SpawnWithTimeoutResult,
	spawnWithTimeout,
} from "../../helpers/spawn-policy.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import {
	CONNECTIVITY_CHECK_DOMAIN,
	CONNECTIVITY_CHECK_PATH,
	formatUrlHost,
} from "./internet.ts";

/**
 * A kernel interface name that is safe to hand to an argv slot. Deliberately
 * the SAME shape `router-cellular-admin.ts` guards its own curl binding with —
 * that module imports this constant rather than keeping a second copy, so the
 * two device-bound spawn sites can never disagree about what a name may be.
 *
 * `argMatch(ID_RE, …)`-equivalent, plus the kernel's own 15-character `IFNAMSIZ`
 * ceiling. The FIRST character deliberately excludes `-`, mirroring
 * `argMatch`'s separate `startsWith("-")` refusal: a name like `--upload-file`
 * is otherwise a well-formed member of the character class and would be read by
 * curl as a flag rather than as the value of `--interface`.
 */
export const SAFE_IFNAME_RE: RegExp = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,14}$/;

export function isSafeIfname(ifname: string): boolean {
	return SAFE_IFNAME_RE.test(ifname);
}

/** Wall-clock budget for one device-bound probe. Matches the unbound probe. */
export const DEVICE_PROBE_TIMEOUT_MS = 4000;

/**
 * curl writes the body first and then our `--write-out` suffix, so the status
 * code is the tail after the LAST separator. A literal marker is used rather
 * than a bare newline because a captive portal's HTML body is multi-line.
 */
export const PROBE_STATUS_MARKER = "\n<<<ceraui-probe-status>>>";

/**
 * The argv for one device-bound probe. Pure, so the binding is assertable
 * without a board: the interface reaches argv as its own `--interface <name>`
 * element and the destination is the externally-resolved address, never a
 * gateway.
 */
export function buildDeviceBoundProbeArgv(
	remoteAddr: string,
	ifname: string,
	timeoutMs: number = DEVICE_PROBE_TIMEOUT_MS,
): string[] {
	if (!isSafeIfname(ifname)) {
		throw new Error(`refusing to bind a probe to a suspect ifname: ${ifname}`);
	}
	const seconds = Math.max(1, Math.round(timeoutMs / 1000));
	return [
		"curl",
		"--silent",
		"--interface",
		ifname,
		"--max-time",
		String(seconds),
		"--header",
		`Host: ${CONNECTIVITY_CHECK_DOMAIN}`,
		"--write-out",
		`${PROBE_STATUS_MARKER}%{http_code}`,
		`http://${formatUrlHost(remoteAddr)}${CONNECTIVITY_CHECK_PATH}`,
	];
}

/** The `{code, body}` pair carried by a completed probe's stdout. */
export type ProbeResponse = { code: number; body: string };

/**
 * Split curl's stdout back into body + status. Output with no marker never ran
 * to completion (a killed transfer), which is reported as code 0 rather than
 * being mistaken for an empty successful answer.
 */
export function parseCurlProbeResponse(stdout: string): ProbeResponse {
	const at = stdout.lastIndexOf(PROBE_STATUS_MARKER);
	if (at === -1) return { code: 0, body: stdout };
	const body = stdout.slice(0, at);
	const code = Number.parseInt(
		stdout.slice(at + PROBE_STATUS_MARKER.length).trim(),
		10,
	);
	return { code: Number.isFinite(code) ? code : 0, body };
}

const CONNECTIVITY_CHECK_CODE = 204;

/** Effectful surface, injected so the binding is provable with no `curl`. */
export type DeviceBoundProbeDeps = {
	runProbe: (argv: string[]) => Promise<SpawnWithTimeoutResult>;
	shouldUseMocks: () => boolean;
};

export const defaultDeviceBoundProbeDeps: DeviceBoundProbeDeps = {
	runProbe: (argv) =>
		spawnWithTimeout(argv, { timeoutMs: DEVICE_PROBE_TIMEOUT_MS + 1000 }),
	shouldUseMocks,
};

export type DeviceProbeVerdict = "reachable" | "captive_portal" | "unreachable";

export async function probeConnectivityViaDevice(
	remoteAddr: string,
	ifname: string,
	deps: DeviceBoundProbeDeps = defaultDeviceBoundProbeDeps,
): Promise<DeviceProbeVerdict> {
	if (deps.shouldUseMocks()) return "reachable";
	try {
		const result = await deps.runProbe(
			buildDeviceBoundProbeArgv(remoteAddr, ifname),
		);
		const { code, body } = parseCurlProbeResponse(result.stdout);
		if (code === CONNECTIVITY_CHECK_CODE && body === "") return "reachable";
		if ((code >= 300 && code < 400) || body.length > 0) return "captive_portal";
		return "unreachable";
	} catch (err) {
		logger.debug(
			`device-bound connectivity probe via ${ifname} failed: ${String(err)}`,
		);
		return "unreachable";
	}
}

/**
 * Is `remoteAddr` reachable through the physical interface `ifname`?
 *
 * The verdict is per DEVICE, so two interfaces sharing one address get two
 * INDEPENDENT answers — which is the whole point: a WAN outage on one twin must
 * mark that twin unhealthy and leave its sibling alone.
 */
export async function checkConnectivityViaDevice(
	remoteAddr: string,
	ifname: string,
	deps: DeviceBoundProbeDeps = defaultDeviceBoundProbeDeps,
): Promise<boolean> {
	return (
		(await probeConnectivityViaDevice(remoteAddr, ifname, deps)) === "reachable"
	);
}
