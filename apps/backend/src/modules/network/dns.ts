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

import { loadCacheFile } from "../../helpers/config-loader.ts";
import { type DnsCache, dnsCacheSchema } from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import { writeTextFileAtomic } from "../../helpers/text-files.ts";
import { haveSameElements } from "./dns-cache.ts";

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

/** The slice of `dns.Resolver` this module drives — narrow so a test double
 *  satisfies it without reimplementing every c-ares overload. */
export interface DnsResolverLike {
	resolve4(
		hostname: string,
		callback: (
			err: NodeJS.ErrnoException | null,
			addresses: Array<string>,
		) => void,
	): void;
	resolve6(
		hostname: string,
		callback: (
			err: NodeJS.ErrnoException | null,
			addresses: Array<string>,
		) => void,
	): void;
	cancel(): void;
}

const realResolverFactory = (): DnsResolverLike => new Resolver();
let resolverFactory: () => DnsResolverLike = realResolverFactory;

/** Test seam (mirrors `setIfaceResolverForTest`): swap the Resolver factory for
 *  a double; `null` restores the real one. Never call from production code. */
export function setDnsResolverFactoryForTest(
	factory: (() => DnsResolverLike) | null,
): void {
	resolverFactory = factory ?? realResolverFactory;
}

/*
  dns.Resolver uses c-ares, with each instance (and the global
  dns.resolve*() functions) mapped one-to-one to a c-ares channel

  c-ares channels re-use the underlying UDP sockets for multi queries,
  which is good for performance but the incorrect behaviour for us, as
  it can end up trying to use stale connections long after we change
  the default route after a network becomes unavailable

  We therefore create a new instance for every query. Sharing one across
  unrelated queries is unsafe because resolver.cancel() on timeout makes every
  pending query on that channel time out with it.
*/
function resolveP(hostname: string, rrtype: ResolveType | undefined) {
	if (rrtype === undefined) {
		const ipv4Resolver = resolverFactory(),
			ipv6Resolver = resolverFactory();

		return new Promise<ResolveResult>((resolve, reject) => {
			let ipv4Res: ResolveResult | undefined;
			let ipv6Res: ResolveResult | undefined;
			let ipv4Settled = false,
				ipv6Settled = false;
			let ipv4Timeout: ReturnType<typeof setTimeout> | undefined;
			let ipv6Timeout: ReturnType<typeof setTimeout> | undefined;

			const returnResults = () => {
				if (!ipv4Settled || !ipv6Settled) return;
				if (ipv4Timeout) clearTimeout(ipv4Timeout);
				if (ipv6Timeout) clearTimeout(ipv6Timeout);

				const res = [...(ipv4Res ?? []), ...(ipv6Res ?? [])];
				if (res.length === 0)
					return reject(`DNS record not found for ${hostname}`);
				resolve(res);
			};

			const complete = (family: ResolveType, result: ResolveResult) => {
				if (family === "a") {
					if (ipv4Settled) return;
					ipv4Settled = true;
					ipv4Res = result;
					if (ipv4Timeout) clearTimeout(ipv4Timeout);
				} else {
					if (ipv6Settled) return;
					ipv6Settled = true;
					ipv6Res = result;
					if (ipv6Timeout) clearTimeout(ipv6Timeout);
				}
				returnResults();
			};
			const armTimeout = (family: ResolveType, resolver: DnsResolverLike) =>
				DNS_TIMEOUT
					? setTimeout(() => {
							resolver.cancel();
							complete(family, null);
						}, DNS_TIMEOUT)
					: undefined;
			ipv4Timeout = armTimeout("a", ipv4Resolver);
			ipv6Timeout = armTimeout("aaaa", ipv6Resolver);

			ipv4Resolver.resolve4(hostname, (err, addresses) => {
				complete("a", err ? null : addresses);
			});
			ipv6Resolver.resolve6(hostname, (err, addresses) => {
				complete("aaaa", err ? null : addresses);
			});
		});
	}

	const resolver = resolverFactory();

	return new Promise<ResolveResult>((resolve, reject) => {
		let to: ReturnType<typeof setTimeout> | undefined;

		if (DNS_TIMEOUT) {
			to = setTimeout(() => {
				resolver.cancel();
				reject(`DNS timeout for ${hostname}`);
			}, DNS_TIMEOUT);
		}

		let ipv4Res: ResolveResult = null;
		if (rrtype === "a") {
			resolver.resolve4(hostname, (err, address) => {
				ipv4Res = err ? null : address;
				returnResults();
			});
		}

		let ipv6Res: ResolveResult = null;
		if (rrtype === "aaaa") {
			resolver.resolve6(hostname, (err, address) => {
				ipv6Res = err ? null : address;
				returnResults();
			});
		}

		const returnResults = () => {
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

const dnsCache: DnsCache = await loadCacheFile(DNS_CACHE_FILE, dnsCacheSchema);
const dnsResults: Record<string, ResolveResult> = {};

/** Test seam for proving cache replacement without writing a fixture into the checkout. */
export function setDnsCacheEntryForTest(
	name: string,
	results: readonly string[] | null,
): void {
	delete dnsResults[name];
	if (results === null) {
		delete dnsCache[name];
		return;
	}
	dnsCache[name] = { ts: Date.now(), results: [...results] };
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

	/* The well-known check and the caller's query are INDEPENDENT lookups: the
     check only GATES whether the answer is trusted, it is never an input to it.
     Awaiting them in series put a second full DNS round-trip on the stream-start
     critical path (`resolveSrtla` runs inside the per-attempt launch deadline)
     for no ordering reason, so they fly concurrently and the call costs
     max(check, query) instead of check + query.

     Separate Resolver instances are REQUIRED here, not an optimisation: a shared
     c-ares channel's cancel() on timeout aborts every pending query on it, so one
     leg timing out would kill its sibling mid-flight. */
	const validated = resolveP(DNS_WELLKNOWN_NAME, "a").then(
		(lookup) => {
			if (lookup && lookup.length === 1 && lookup[0] === DNS_WELLKNOWN_ADDR) {
				return true;
			}
			logger.error(
				`DNS validation failure: got result ${lookup} instead of the expected ${DNS_WELLKNOWN_ADDR}`,
			);
			return false;
		},
		(e) => {
			logger.error(`DNS validation failure: ${e}`);
			return false;
		},
	);
	const queried = resolveP(name, rrtype).then(
		(addrs): { ok: true; addrs: ResolveResult } => ({ ok: true, addrs }),
		(err): { ok: false; err: unknown } => ({ ok: false, err }),
	);
	const [goodDns, answer] = await Promise.all([validated, queried]);

	/* A speculative answer from a network that failed the check is DISCARDED
     unread, and its error deliberately unlogged — the serial version never
     issued that query, so logging it would invent a new failure line. */
	if (!goodDns) {
		delete dnsResults[name];
	} else if (answer.ok) {
		const res = answer.addrs ?? [];
		dnsResults[name] = res;

		return { addrs: res, fromCache: false };
	} else {
		logger.error(`dns error ${answer.err}`);
	}

	const cachedEntry = dnsCache[name];
	if (cachedEntry) return { addrs: cachedEntry.results, fromCache: true };

	throw "DNS query failed and no cached value is available";
}

export async function dnsCacheValidate(name: string) {
	if (!dnsResults[name]) {
		logger.warn(`DNS: error validating results for ${name}: not found`);
		return;
	}

	const cachedEntry = dnsCache[name];

	if (
		!cachedEntry ||
		!haveSameElements(dnsResults[name], cachedEntry.results)
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
			writeTextFileAtomic(DNS_CACHE_FILE, JSON.stringify(dnsCache));
		}
	}
}
