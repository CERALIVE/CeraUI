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
  DNS utils w/ a persistent cache
*/

import { Resolver } from "node:dns";
import fs from "node:fs";

import { logger } from "../../helpers/logger.ts";
import { writeTextFile } from "../../helpers/text-files.ts";

const DNS_CACHE_FILE = "dns_cache.json";
/* Minimum age of an updated record to trigger a persistent DNS cache update (in ms)
   Some records change with almost every query if using CDNs, etc
   This limits the frequency of file writes */
const DNS_MIN_AGE = 60_000; // in ms
const DNS_TIMEOUT = 2_000; // in ms
const DNS_WELLKNOWN_NAME = "wellknown.belabox.net";
const DNS_WELLKNOWN_ADDR = "127.1.33.7";

type ResolveResult = Array<string> | null;

type ResolveType = "a" | "aaaa";

/*
  dns.Resolver uses c-ares, with each instance (and the global
  dns.resolve*() functions) mapped one-to-one to a c-ares channel

  c-ares channels re-use the underlying UDP sockets for multi queries,
  which is good for performance but the incorrect behaviour for us, as
  it can end up trying to use stale connections long after we change
  the default route after a network becomes unavailable

  For simplicity, we create a new instance for each query unless one
  is provided by the caller. The callers shouldn't reuse Resolver
  instances for unrelated queries as we call resolver.cancel() on
  timeout, which will make all pending queries time out.
*/
function resolveP(
	hostname: string,
	rrtype: ResolveType | undefined,
	existingResolver?: Resolver,
) {
	const resolver = existingResolver ?? new Resolver();

	return new Promise<ResolveResult>((resolve, reject) => {
		let to: ReturnType<typeof setTimeout> | undefined;

		if (DNS_TIMEOUT) {
			to = setTimeout(() => {
				resolver.cancel();
				reject(`DNS timeout for ${hostname}`);
			}, DNS_TIMEOUT);
		}

		let ipv4Res: ResolveResult = null;
		if (rrtype === undefined || rrtype === "a") {
			resolver.resolve4(hostname, (err, address) => {
				ipv4Res = err ? null : address;
				returnResults();
			});
		}

		let ipv6Res: ResolveResult = null;
		if (rrtype === undefined || rrtype === "aaaa") {
			resolver.resolve6(hostname, (err, address) => {
				ipv6Res = err ? null : address;
				returnResults();
			});
		}

		const returnResults = () => {
			// If querying both for A and AAAA records, wait for the IPv4 result
			if (rrtype === undefined && ipv4Res === undefined) return;

			let res: ResolveResult = null;
			if (ipv4Res) {
				res = ipv4Res;
			} else if (ipv6Res) {
				res = ipv6Res;
			}

			if (res) {
				if (to) {
					clearTimeout(to);
				}
				resolve(res);
			} else {
				reject(`DNS record not found for ${hostname}`);
			}
		};
	});
}

type DnsCacheEntry = {
	ts: number;
	results: NonNullable<ResolveResult>;
};

let dnsCache: Record<string, DnsCacheEntry> = {};
const dnsResults: Record<string, ResolveResult> = {};
try {
	dnsCache = JSON.parse(fs.readFileSync(DNS_CACHE_FILE, "utf8"));
} catch (_err) {
	logger.warn(
		"Failed to load the persistent DNS cache, starting with an empty cache",
	);
}

function isIpv4Addr(val: string) {
	return val.match(/^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}$/) != null;
}

function isValidResolveType(rrtype: string): rrtype is ResolveType {
	return rrtype === "a" || rrtype === "aaaa";
}

function normalizeResolveType(
	rrtype: string | undefined,
): ResolveType | undefined {
	if (rrtype === undefined) return undefined;
	const normalized = rrtype.toLowerCase();
	if (isValidResolveType(normalized)) return normalized;

	throw "Invalid rrtype";
}

export async function dnsCacheResolve(name: string, rrtype_?: string) {
	const rrtype = normalizeResolveType(rrtype_);
	if (isIpv4Addr(name) && rrtype !== "aaaa") {
		return { addrs: [name], fromCache: false };
	}

	let badDns = true;

	// Reuse the Resolver instance for the actual query after a succesful validation
	const resolver = new Resolver();

	/* Assume that DNS resolving is broken, unless it returns
     the expected result for a known name */
	try {
		const lookup = await resolveP(DNS_WELLKNOWN_NAME, "a", resolver);
		if (lookup && lookup.length === 1 && lookup[0] === DNS_WELLKNOWN_ADDR) {
			badDns = false;
		} else {
			logger.error(
				`DNS validation failure: got result ${lookup} instead of the expected ${DNS_WELLKNOWN_ADDR}`,
			);
		}
	} catch (e) {
		logger.error(`DNS validation failure: ${e}`);
	}

	if (badDns) {
		delete dnsResults[name];
	} else {
		try {
			const res = (await resolveP(name, rrtype, resolver)) ?? [];
			dnsResults[name] = res;

			return { addrs: res, fromCache: false };
		} catch (err) {
			logger.error(`dns error ${err}`);
		}
	}

	const cachedEntry = dnsCache[name];
	if (cachedEntry) return { addrs: cachedEntry.results, fromCache: true };

	throw "DNS query failed and no cached value is available";
}

// biome-ignore lint/suspicious/noExplicitAny: typescript workaround
type SomeValue = keyof any;

function compareArrayElements(a1: Array<SomeValue>, a2: Array<SomeValue>) {
	if (!Array.isArray(a1) || !Array.isArray(a2)) return false;

	const cmp: Record<SomeValue, boolean> = {};
	for (const e of a1) {
		cmp[e] = false;
	}

	// check that all elements of a2 are in a1
	for (const e of a2) {
		if (cmp[e] === undefined) {
			return false;
		}
		cmp[e] = true;
	}

	// check that all elements of a1 are in a2
	for (const e in cmp) {
		if (!cmp[e]) return false;
	}

	return true;
}

export async function dnsCacheValidate(name: string) {
	if (!dnsResults[name]) {
		logger.warn(`DNS: error validating results for ${name}: not found`);
		return;
	}

	const cachedEntry = dnsCache[name];

	if (
		!cachedEntry ||
		!compareArrayElements(dnsResults[name], cachedEntry.results)
	) {
		const writeFile = !(
			cachedEntry?.ts && Date.now() - cachedEntry.ts < DNS_MIN_AGE
		);

		dnsCache[name] = cachedEntry ?? {
			ts: Date.now(),
			results: [],
		};

		dnsCache[name].results = dnsResults[name];

		if (writeFile) {
			dnsCache[name].ts = Date.now();
			await writeTextFile(DNS_CACHE_FILE, JSON.stringify(dnsCache));
		}
	}
}
