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
  WHERE A DEVICE-BOUND UPLINK PROBE IS AIMED.

  The probe asserts `internet.ts`'s exact contract — HTTP 204 with an EMPTY body
  at `CONNECTIVITY_CHECK_PATH`, under a `Host: CONNECTIVITY_CHECK_DOMAIN` header
  — so the DESTINATION has to be an address that serves it. The uplink-health
  runtime used to aim every probe at a HARDCODED `1.1.1.1`, which serves that
  path to nobody: Cloudflare answers a 3xx/HTML redirect, `device-bound-probe.ts`
  reads a 3xx-or-bodied answer as a captive portal (correctly, given what it was
  handed), and the model then makes captive interception INSTANTLY `degraded`
  while zeroing the success counter — so recovery (5 successes + a 15 s dwell)
  was unreachable and every healthy probed uplink read permanently Degraded.

  This module answers "which address currently serves that check", the same way
  `gateways.ts` already does for the unbound probe: `dnsCacheResolve`, which
  carries its own persistent cache and its own hijacked-DNS validation.

  TWO PROPERTIES ARE LOAD-BEARING.

  CACHED. The probe round runs every `probeRoundCadenceMs` (5 s) and
  `dnsCacheResolve` issues TWO real DNS queries per call (the caller's plus the
  well-known health check), so resolving per round would put 24 lookups a minute
  on a device whose uplinks may be cellular. The answer is memoised for
  `CONNECTIVITY_TARGET_TTL_MS` and every concurrent caller joins one in-flight
  resolution.

  FAIL-SOFT, AND NEVER FABRICATED. A resolution that throws falls back to the
  last address this resolver successfully obtained — a stale-but-real target is
  strictly better evidence than none. With NO previous address it answers
  `undefined`, and the caller must SKIP its probe round rather than invent an
  outcome: an unreachable DNS server says nothing about whether an uplink can
  carry traffic, and recording a `failure` for it is exactly the fabrication that
  made this signal untrustworthy in the first place.
*/

import { logger } from "../../../helpers/logger.ts";
import { dnsCacheResolve } from "../dns.ts";
import { CONNECTIVITY_CHECK_DOMAIN } from "../internet.ts";

/**
 * How long a resolved connectivity-check address is reused before the resolver
 * asks DNS again. Deliberately far longer than the probe cadence: the target is
 * a large anycast CDN name whose addresses are interchangeable for a 204 check,
 * and re-resolving per round is a cost with no evidence behind it.
 */
export const CONNECTIVITY_TARGET_TTL_MS = 300_000;

/** Effectful surface, injected so the caching + fail-soft rules are provable. */
export interface ConnectivityTargetDeps {
	/** The shared DNS machinery. Rejects when nothing (live or cached) answers. */
	readonly resolve: (
		name: string,
	) => Promise<{ addrs: readonly string[]; fromCache: boolean }>;
	readonly now: () => number;
}

export const defaultConnectivityTargetDeps: ConnectivityTargetDeps = {
	resolve: (name) => dnsCacheResolve(name),
	now: Date.now,
};

/** Resolves the connectivity-check address, or `undefined` when it cannot. */
export type ConnectivityTargetResolver = () => Promise<string | undefined>;

export function createConnectivityTargetResolver(
	deps: ConnectivityTargetDeps = defaultConnectivityTargetDeps,
	domain: string = CONNECTIVITY_CHECK_DOMAIN,
): ConnectivityTargetResolver {
	let cachedAddr: string | undefined;
	let cachedAt = 0;
	let inflight: Promise<string | undefined> | undefined;

	const refresh = async (): Promise<string | undefined> => {
		try {
			const { addrs } = await deps.resolve(domain);
			const addr = addrs[0];
			if (addr === undefined) throw new Error(`no address for ${domain}`);
			cachedAddr = addr;
			cachedAt = deps.now();
			return addr;
		} catch (err) {
			// A failed lookup is a statement about DNS, never about an uplink. Keep
			// serving the last real address if we have one; otherwise say so, so the
			// caller skips its round instead of recording a fabricated failure.
			logger.debug(
				`uplink-health: could not resolve ${domain}: ${String(err)}${
					cachedAddr === undefined
						? ""
						: ` — reusing the last resolved address ${cachedAddr}`
				}`,
			);
			return cachedAddr;
		} finally {
			inflight = undefined;
		}
	};

	return () => {
		if (
			cachedAddr !== undefined &&
			deps.now() - cachedAt < CONNECTIVITY_TARGET_TTL_MS
		) {
			return Promise.resolve(cachedAddr);
		}
		inflight ??= refresh();
		return inflight;
	};
}
