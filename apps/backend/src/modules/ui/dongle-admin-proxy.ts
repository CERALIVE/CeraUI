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
  The EFFECTFUL half of the router-dongle admin-UI reverse proxy.

  Target resolution is the whole safety argument, and it runs in ONE direction:

      wire id  ->  INTERFACE  ->  that interface's own default gateway

  never the reverse. The id resolves through the same synthetic-allocation map
  the Stage-B router writes use (`routerCellularIfnameForWireId`), so the proxy
  and every other router mutation address the same physical device by the same
  identity. The address is then read from THAT interface's default route — the
  rule `router-cellular-admin.ts` already follows — so a re-subnetted or
  unfamiliar dongle still resolves, and an address is never an INPUT to the
  decision. Two identical twins therefore produce two different `--interface`
  bindings from one identical gateway address, which is exactly the case that
  makes a destination-addressed proxy wrong.
*/

import { randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
	DONGLE_ADMIN_COOKIE,
	DONGLE_ADMIN_PATH_PREFIX,
	DONGLE_ADMIN_TOKEN_PARAM,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { routerCellularIfnameForWireId } from "../modems/modem-wire-producer.ts";
import {
	ADMIN_PROXY_TIMEOUT_MS,
	buildAdminProxyArgv,
	dongleAdminBase,
	forwardableRequestHeaders,
	isRewritableContentType,
	parseAdminHeaderDump,
	parseDongleAdminPath,
	placeOnCpus,
	rewriteAdminBody,
	rewriteResponseHeaders,
	shouldRewriteBody,
	sniffAbsentContentType,
} from "../network/router-admin-proxy.ts";
import {
	defaultRouterAdminProbeDeps,
	parseDefaultGateways,
} from "../network/router-cellular-admin.ts";
import {
	cookiesForDongle,
	dongleAdminSessionCookie,
	exchangeDongleAdminToken,
	isDongleAdminSession,
	readCookie,
} from "./dongle-admin-session.ts";

export type DongleAdminTarget = {
	readonly ifname: string;
	/** `http://<gateway>` — the interface's OWN default gateway, never a literal. */
	readonly adminOrigin: string;
};

export type ProxyCurlResult = {
	readonly stdout: Uint8Array;
	/** curl's `--dump-header` output — the response's own header block. */
	readonly headerDump: string;
	readonly exitCode: number;
};

export type DongleAdminProxyDeps = {
	resolveIfname: (wireId: number) => string | undefined;
	runIpRouteShowDefault: () => Promise<string>;
	runCurl: (
		argv: readonly string[],
		body: Uint8Array | undefined,
	) => Promise<ProxyCurlResult>;
};

/** How long one reading of the kernel's default-route table may be reused. */
export const DEFAULT_ROUTE_CACHE_TTL_MS = 5_000;

let routeTable:
	| { readonly text: string; readonly expiresAt: number }
	| undefined;

/*
  ONE `ip route` READING PER BURST, NOT PER ASSET.

  An admin UI is one navigation and then dozens of asset requests — the ZTE's
  own page issues 71 — and each of them re-spawned `ip -4 route show default`
  to ask a question whose answer cannot have changed in the meantime.
  Board-measured, that spawn is 3.5 ms and a whole second process, so the page
  paid roughly a quarter of a second and 71 processes for one routing fact.

  It caches the ROUTE TABLE, never the wire-id → interface mapping. That
  distinction is the safety argument: which INTERFACE a wire id names is
  re-resolved on every single request, from the in-memory map and with no
  spawn, so the binding — the only thing that decides WHICH physical twin
  answers — is exactly as fresh as it was. Only "what is that interface's own
  default gateway" is reused, and a dongle re-subnetted mid-session invalidates
  itself the moment a request fails against the stale address.
*/
export async function cachedDefaultRoutes(
	read: () => Promise<string> = defaultRouterAdminProbeDeps.runIpRouteShowDefault,
): Promise<string> {
	const now = Date.now();
	if (routeTable !== undefined && routeTable.expiresAt > now)
		return routeTable.text;
	const text = await read();
	routeTable = { text, expiresAt: now + DEFAULT_ROUTE_CACHE_TTL_MS };
	return text;
}

/** Drop the cached route table so the next resolution re-reads the kernel. */
export function invalidateDefaultRouteCache(): void {
	routeTable = undefined;
}

const CPU_DIR = "/sys/devices/system/cpu";

let performanceCpus: Promise<string | undefined> | undefined;

/*
  WHICH CORES ARE THE FAST ONES — ASKED, NEVER ASSUMED.

  Derived from the cores' OWN reported ceiling (`cpufreq/cpuinfo_max_freq`), so
  it names a cluster on any heterogeneous board rather than pinning this repo to
  one SoC's core numbering — the same rule the onboard display-name tables
  follow: key on what the hardware reports, never on a board model. A machine
  whose cores all report ONE ceiling is uniform and answers `undefined`, which
  builds the byte-identical argv the proxy has always built; so does a kernel
  with no `cpufreq` at all, or an image with no `taskset`.
*/
async function discoverPerformanceCpus(): Promise<string | undefined> {
	try {
		const entries = await readdir(CPU_DIR);
		const ceilings = new Map<number, number[]>();
		for (const entry of entries) {
			const matched = /^cpu(\d+)$/.exec(entry);
			if (matched?.[1] === undefined) continue;
			const khz = Number.parseInt(
				(
					await Bun.file(`${CPU_DIR}/${entry}/cpufreq/cpuinfo_max_freq`).text()
				).trim(),
				10,
			);
			if (!Number.isFinite(khz)) continue;
			const cpu = Number.parseInt(matched[1], 10);
			ceilings.set(khz, [...(ceilings.get(khz) ?? []), cpu]);
		}
		if (ceilings.size < 2) return undefined;
		const fastest = Math.max(...ceilings.keys());
		const cpus = ceilings.get(fastest);
		if (cpus === undefined || cpus.length === 0) return undefined;
		if (!(await Bun.file("/usr/bin/taskset").exists())) return undefined;
		return [...cpus].sort((a, b) => a - b).join(",");
	} catch {
		return undefined;
	}
}

function resolvePerformanceCpus(): Promise<string | undefined> {
	performanceCpus ??= discoverPerformanceCpus();
	return performanceCpus;
}

/** Re-ask for the CPU topology on the next request (test seam). */
export function resetPerformanceCpuPlacement(): void {
	performanceCpus = undefined;
}

/*
  THE HEADER DUMP GOES TO A TEMP FILE, NOT TO `/dev/stderr`.

  Board-measured on `ceralive2`: `--dump-header /dev/stderr` against a Bun PIPE
  never completes — `proc.exitCode` comes back `null` with both streams EMPTY,
  while the identical argv writing to a file exits 0 with a 277-byte body and a
  full header block. It also works when the shell redirects stderr to a real
  file, which is exactly why a hand-run `curl … 2>/tmp/h` looks fine and the same
  command under `Bun.spawn` does not. Reading the body off stdout and the headers
  off a file keeps a BINARY body free of any in-band delimiter parsing, which is
  the property `/dev/stderr` was chosen for in the first place.
*/
async function spawnProxyCurl(
	argv: readonly string[],
	body: Uint8Array | undefined,
): Promise<ProxyCurlResult> {
	const headerPath = `${tmpdir()}/ceraui-dongle-hdr-${process.pid}-${randomUUID()}`;
	try {
		const spawned = placeOnCpus(
			[...argv, "--dump-header", headerPath],
			await resolvePerformanceCpus(),
		);
		const proc = Bun.spawn(spawned, {
			stdin: body === undefined ? "ignore" : body,
			stdout: "pipe",
			stderr: "ignore",
		});
		const stdout = await new Response(proc.stdout).arrayBuffer();
		await proc.exited;
		let headerDump = "";
		try {
			headerDump = await Bun.file(headerPath).text();
		} catch {
			// No dump means no response reached us; the status parse reports it.
		}
		return {
			stdout: new Uint8Array(stdout),
			headerDump,
			exitCode: proc.exitCode ?? -1,
		};
	} finally {
		// Fire-and-forget: the operator's response must not wait on a tmpfs unlink.
		void unlink(headerPath).catch(() => undefined);
	}
}

export const defaultDongleAdminProxyDeps: DongleAdminProxyDeps = {
	resolveIfname: routerCellularIfnameForWireId,
	runIpRouteShowDefault: () => cachedDefaultRoutes(),
	runCurl: spawnProxyCurl,
};

/**
 * Resolve a wire id to the interface it names and that interface's own admin
 * address. Either step failing answers `undefined` — a best-guess interface or a
 * hardcoded `192.168.8.1` would proxy to whichever twin the kernel happened to
 * pick, which is the exact defect this module exists to avoid.
 */
export async function resolveDongleAdminTarget(
	wireId: number,
	deps: DongleAdminProxyDeps = defaultDongleAdminProxyDeps,
): Promise<DongleAdminTarget | undefined> {
	const ifname = deps.resolveIfname(wireId);
	if (ifname === undefined || ifname === "") return undefined;
	let gateways: ReadonlyMap<string, string>;
	try {
		gateways = parseDefaultGateways(await deps.runIpRouteShowDefault());
	} catch {
		return undefined;
	}
	const gateway = gateways.get(ifname);
	if (gateway === undefined) return undefined;
	return { ifname, adminOrigin: `http://${gateway}` };
}

/** The leading bytes `sniffAbsentContentType` inspects, and no more. */
const SNIFF_PREFIX_BYTES = 512;

function decodeSniffPrefix(body: Uint8Array): string {
	return new TextDecoder().decode(body.subarray(0, SNIFF_PREFIX_BYTES));
}

function unauthorized(): Response {
	return new Response("Admin session required", { status: 401 });
}

/**
 * Handle one request under {@link DONGLE_ADMIN_PATH_PREFIX}, or `null` when the
 * path is not ours (so the caller falls through to the ordinary flow).
 */
export async function handleDongleAdminRequest(
	req: Request,
	deps: DongleAdminProxyDeps = defaultDongleAdminProxyDeps,
): Promise<Response | null> {
	const url = new URL(req.url);
	const route = parseDongleAdminPath(url.pathname, DONGLE_ADMIN_PATH_PREFIX);
	if (route === undefined) {
		return url.pathname === DONGLE_ADMIN_PATH_PREFIX
			? new Response("Not Found", { status: 404 })
			: null;
	}

	// A token opens the session and is then REMOVED from the URL by a redirect, so
	// it never lingers in browser history or in a referrer the dongle would see.
	const presented = url.searchParams.get(DONGLE_ADMIN_TOKEN_PARAM);
	if (presented !== null) {
		const session = exchangeDongleAdminToken(presented);
		if (session === undefined) return unauthorized();
		url.searchParams.delete(DONGLE_ADMIN_TOKEN_PARAM);
		return new Response(null, {
			status: 302,
			headers: {
				Location: `${url.pathname}${url.search}`,
				"Set-Cookie": dongleAdminSessionCookie(session),
			},
		});
	}

	const cookieHeader = req.headers.get("cookie");
	if (!isDongleAdminSession(readCookie(cookieHeader, DONGLE_ADMIN_COOKIE))) {
		return unauthorized();
	}

	const target = await resolveDongleAdminTarget(route.wireId, deps);
	if (target === undefined) {
		return new Response("Dongle not reachable", { status: 502 });
	}

	const base = dongleAdminBase(DONGLE_ADMIN_PATH_PREFIX, route.wireId);
	const upstream = `${target.adminOrigin}${route.rest}${url.search}`;
	const headers = forwardableRequestHeaders(
		req.headers.entries(),
		cookiesForDongle(cookieHeader),
	);

	const hasBody = req.method !== "GET" && req.method !== "HEAD";
	const body = hasBody ? new Uint8Array(await req.arrayBuffer()) : undefined;
	const argv = buildAdminProxyArgv(
		target.ifname,
		upstream,
		req.method,
		headers,
		ADMIN_PROXY_TIMEOUT_MS,
	);
	if (body !== undefined) argv.push("--data-binary", "@-");

	let result: Awaited<ReturnType<DongleAdminProxyDeps["runCurl"]>>;
	try {
		result = await deps.runCurl(argv, body);
	} catch (err) {
		logger.debug(
			`dongle admin proxy via ${target.ifname} failed: ${String(err)}`,
		);
		invalidateDefaultRouteCache();
		return new Response("Dongle not reachable", { status: 502 });
	}
	if (result.exitCode !== 0) {
		invalidateDefaultRouteCache();
		return new Response("Dongle not reachable", { status: 502 });
	}

	const parsed = parseAdminHeaderDump(result.headerDump);
	if (parsed.status === 0) {
		invalidateDefaultRouteCache();
		return new Response("Dongle not reachable", { status: 502 });
	}
	const outHeaders = rewriteResponseHeaders(parsed, target.adminOrigin, base);

	// A dongle that stated no content-type gets one sniffed from its own body,
	// because `Bun.serve` would otherwise call it `application/octet-stream` and
	// the browser would download the admin page. See `sniffAbsentContentType`.
	// The sniff reads a bounded PREFIX: it is a question about the first bytes,
	// and decoding a whole image to answer it copies every byte for nothing.
	let contentType = outHeaders.get("content-type") ?? undefined;
	if (contentType === undefined) {
		contentType = sniffAbsentContentType(decodeSniffPrefix(result.stdout));
		if (contentType !== undefined) outHeaders.set("content-type", contentType);
	}
	const init = { status: parsed.status, headers: outHeaders };

	// A type that could never be rewritten is forwarded as the bytes we received,
	// with no decode at all — an admin UI's images and fonts are most of its
	// requests, and every one of them used to be copied into a throwaway string.
	if (!isRewritableContentType(contentType)) {
		return new Response(result.stdout, init);
	}
	const text = new TextDecoder().decode(result.stdout);
	return shouldRewriteBody(contentType, text)
		? new Response(
				rewriteAdminBody(text, target.adminOrigin, base, contentType),
				init,
			)
		: new Response(result.stdout, init);
}
