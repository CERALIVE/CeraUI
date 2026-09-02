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
  The PURE half of the router-dongle admin-UI reverse proxy.

  WHY A PROXY AT ALL. A router-mode dongle runs its own embedded admin web UI on
  its own LAN. The board can reach it; the operator's browser cannot, because the
  operator only has CeraUI's exposed origin. So CeraUI carries the request.

  WHY IT IS KEYED ON AN INTERFACE, NEVER ON A DESTINATION ADDRESS. Identical
  units ship one factory LAN subnet, so the bench pair BOTH answer on
  `192.168.8.1` and a destination address names a PAIR rather than a device. It
  is worse than ambiguous — board-measured, the ZTE (whose own gateway is
  `192.168.0.1`) also answered a request addressed to `192.168.8.1`, because what
  selects the unit is the BINDING, not the address. `SO_BINDTODEVICE` is the only
  thing that names one, and `curl --interface` is the only client on this box
  that speaks it — the same established mechanism `router-cellular-admin.ts` and
  `device-bound-probe.ts` already use, applied to a full HTTP exchange rather
  than a single read.

  WHAT IT DOES NOT PROMISE. Absolute-path URL rewriting is a best-effort
  transform over TEXT responses so an opaque vendor SPA loads under a path
  prefix. It cannot follow a URL a script assembles at runtime out of fragments,
  and it deliberately leaves DATA payloads alone (see `shouldRewriteBody`). The
  binding — the part that decides WHICH physical unit answers — is exact and
  does not depend on any of it.
*/

import { SAFE_IFNAME_RE } from "./safe-ifname.ts";

/** Wall-clock budget for one proxied admin request. */
export const ADMIN_PROXY_TIMEOUT_MS = 15_000;

/** Response headers that must never be replayed onto CeraUI's own origin. */
const STRIPPED_RESPONSE_HEADERS = new Set([
	// Would forbid framing/downgrade CeraUI's origin on the dongle's behalf.
	"x-frame-options",
	"content-security-policy",
	"content-security-policy-report-only",
	// A dongle pinning HSTS onto the DEVICE's origin would lock the operator out
	// of a board that legitimately serves plain HTTP on the LAN.
	"strict-transport-security",
	// Recomputed by us: a rewritten body has a different length, and the hop-by-hop
	// framing headers describe the curl transfer rather than our response.
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
	// curl decodes the payload for us (`--compressed`), so what we forward is
	// always identity — replaying the upstream encoding would label plain bytes
	// as gzip. Stripping it is only correct BECAUSE of that flag; the two belong
	// together.
	"content-encoding",
]);

/** Request headers that describe OUR hop and must not be forwarded. */
const STRIPPED_REQUEST_HEADERS = new Set([
	"host",
	"connection",
	"keep-alive",
	"upgrade",
	"transfer-encoding",
	"content-length",
	"accept-encoding",
]);

/**
 * A root-relative URL in an UNQUOTED HTML attribute — whitespace, one of the
 * attributes HTML defines as URL-valued, `=`, then a directory-shaped path. The
 * attribute allowlist is what keeps a JavaScript regex literal out of reach; see
 * `rewriteAdminBody`.
 */
const HTML_UNQUOTED_URL_ATTR_RE =
	/(\s(?:href|src|srcset|action|formaction|poster|data)=)\/(?=[A-Za-z0-9_][A-Za-z0-9_.-]*\/)/gi;

/**
 * webpack's own runtime public-path assignment (`n.p="/"`), which is the base
 * every LAZY chunk URL is assembled from at runtime. See `rewriteAdminBody`.
 */
const WEBPACK_PUBLIC_PATH_RE = /(\.p\s*=\s*)(["'])\/\2/g;

/** A body that is positively a webpack runtime, not merely a script. */
const WEBPACK_RUNTIME_RE = /webpackJsonp|__webpack_require__/;

/** A `taskset -c` CPU list — digits, ranges and commas, nothing else. */
const SAFE_CPU_LIST_RE = /^\d+(?:[-,]\d+)*$/;

/**
 * Run one proxied request on a named CPU set.
 *
 * WHY A PROXY REQUEST CARES WHICH CORE IT LANDS ON. Board-measured on the
 * RK3588 bench (`ceralive2`): a `curl` that does NO network at all
 * (`curl --version`) costs **24 ms**, against 1 ms for `/bin/true` — it links
 * 33 shared objects and the dynamic linker's ~39 000 relative relocations are
 * pointer-chasing work an in-order A55 is bad at. The scheduler places a burst
 * that short on the little cluster, so a request the ZTE answers in **5 ms**
 * spends **25 ms** starting the client that asks. Placed on the big cluster the
 * same request costs **14 ms** (taskset's own exec included) and burns
 * **less than half** the CPU-seconds — this is not "claim the fast cores", it
 * is the same work done for half the machine time.
 *
 * It is a HINT, not a requirement: an empty list is returned unchanged, so a
 * uniform machine (every x86 target, and any board whose cores report one
 * maximum frequency) builds the byte-identical argv it always did. The list is
 * validated rather than trusted — it is spawn argv, and a shell is never
 * involved, but a malformed value would silently mean "run anywhere".
 */
export function placeOnCpus(
	argv: readonly string[],
	cpuList: string | undefined,
): string[] {
	if (cpuList === undefined || cpuList === "") return [...argv];
	if (!SAFE_CPU_LIST_RE.test(cpuList)) {
		throw new Error(`refusing a suspect CPU list: ${cpuList}`);
	}
	return ["taskset", "-c", cpuList, ...argv];
}

export type DongleAdminRoute = {
	/** The `router-ethernet` wire id naming the physical device. */
	readonly wireId: number;
	/** Everything after the id, always leading-slashed. */
	readonly rest: string;
};

/**
 * Split `/dongle-admin/<wireId>/<rest…>` into its parts.
 *
 * A non-numeric id answers `undefined` rather than being coerced: the id is a
 * device identity, and `Number("")` is `0`, which is a REAL wire id.
 */
export function parseDongleAdminPath(
	pathname: string,
	prefix: string,
): DongleAdminRoute | undefined {
	if (!pathname.startsWith(`${prefix}/`)) return undefined;
	const tail = pathname.slice(prefix.length + 1);
	const slash = tail.indexOf("/");
	const idPart = slash === -1 ? tail : tail.slice(0, slash);
	if (!/^\d+$/.test(idPart)) return undefined;
	const rest = slash === -1 ? "/" : tail.slice(slash);
	return { wireId: Number(idPart), rest: rest === "" ? "/" : rest };
}

/** The same-origin prefix every URL of one device's admin UI is rewritten onto. */
export function dongleAdminBase(prefix: string, wireId: number): string {
	return `${prefix}/${wireId}`;
}

/**
 * argv for one proxied request, bound to `ifname`.
 *
 * Pure, so the binding is assertable with no board: the interface reaches argv
 * as its own `--interface <name>` element, and the URL is built from the
 * interface's OWN default gateway rather than from anything the browser sent.
 *
 * `--no-location` is load-bearing — a redirect must be handed back to the
 * browser so it re-enters through this proxy and stays bound, rather than being
 * followed here into a URL nobody rewrote.
 *
 * The response headers are deliberately NOT captured here. Where curl writes
 * them is a runtime concern with a measured constraint behind it (see
 * `dongle-admin-proxy.ts`), while the BINDING this function owns is a contract.
 */
export function buildAdminProxyArgv(
	ifname: string,
	url: string,
	method: string,
	headers: readonly string[],
	timeoutMs: number = ADMIN_PROXY_TIMEOUT_MS,
): string[] {
	if (!SAFE_IFNAME_RE.test(ifname)) {
		throw new Error(
			`refusing to bind the admin proxy to a suspect ifname: ${ifname}`,
		);
	}
	if (!/^[A-Za-z]+$/.test(method)) {
		throw new Error(`refusing a suspect method: ${method}`);
	}
	const argv = [
		"curl",
		"--silent",
		"--no-location",
		"--interface",
		ifname,
		"--max-time",
		String(Math.max(1, Math.round(timeoutMs / 1000))),
		"--request",
		method,
		// The bench HiLink serves its scripts PRE-GZIPPED and answers
		// `Content-Encoding: gzip` even to an explicit `Accept-Encoding: identity`
		// — board-measured. Without this the body reaches the browser as gzip
		// bytes under a `text/javascript` label (and the rewriter sees binary), so
		// the admin page loads its markup and then renders nothing at all.
		"--compressed",
	];
	for (const header of headers) argv.push("--header", header);
	// `--data-binary @-` is appended by the caller when a body is present.
	argv.push(url);
	return argv;
}

/** The request headers worth forwarding, as curl `--header` arguments. */
export function forwardableRequestHeaders(
	headers: Iterable<[string, string]>,
	cookieOverride?: string,
): string[] {
	const out: string[] = [];
	for (const [name, value] of headers) {
		const lower = name.toLowerCase();
		if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
		if (lower === "cookie") continue;
		out.push(`${name}: ${value}`);
	}
	if (cookieOverride !== undefined && cookieOverride !== "") {
		out.push(`Cookie: ${cookieOverride}`);
	}
	// `accept-encoding` is deliberately NOT forwarded and NOT set here: curl's
	// `--compressed` owns that negotiation, and a header set here would override
	// it and leave curl unable to decode what it gets back.
	return out;
}

export type ParsedAdminHeaders = {
	readonly status: number;
	readonly headers: readonly (readonly [string, string])[];
};

/**
 * Parse curl's header dump. A transfer can legitimately carry SEVERAL blocks (a
 * `100 Continue` preface); the LAST block is the response that carried the body,
 * so earlier ones are discarded rather than merged.
 */
export function parseAdminHeaderDump(dump: string): ParsedAdminHeaders {
	let status = 0;
	let headers: (readonly [string, string])[] = [];
	for (const rawLine of dump.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line === "") continue;
		const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/.exec(line);
		if (statusMatch?.[1] !== undefined) {
			status = Number(statusMatch[1]);
			headers = [];
			continue;
		}
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
	}
	return { status, headers };
}

/**
 * Rewrite one absolute URL on the dongle's own origin onto the proxy prefix.
 * Anything pointing elsewhere is returned unchanged — the proxy carries this
 * device's admin UI, not the open internet.
 */
export function rewriteAbsoluteUrl(
	value: string,
	adminOrigin: string,
	base: string,
): string {
	if (value.startsWith(adminOrigin)) {
		const rest = value.slice(adminOrigin.length);
		return `${base}${rest.startsWith("/") ? rest : `/${rest}`}`;
	}
	if (value.startsWith("/") && !value.startsWith("//")) {
		return `${base}${value}`;
	}
	return value;
}

/**
 * The content-type to serve for a response whose upstream stated NONE.
 *
 * WHY THIS IS NOT OPTIONAL, IN BOTH DIRECTIONS. The UFI's embedded httpd infers
 * its `Content-Type` from the URL's file EXTENSION, so an extensionless path
 * answers with the header ABSENT — board-measured, `GET /` returns 200 with a
 * full `<!DOCTYPE html>` body and no content-type at all, while `GET
 * /index.html` returns the byte-identical body WITH `Content-Type: text/html`.
 * The other two dialects never reach this state because both REDIRECT `/` to an
 * explicit `.html` path, so their entry point always carries one.
 *
 * Absence is then not neutral: `Bun.serve` labels a content-type-less response
 * `application/octet-stream`, so the browser is handed a positive
 * "this is a file" and DOWNLOADS the admin page instead of rendering it — the
 * operator-visible bug. It also silences `shouldRewriteBody`, so the page's own
 * `/static/…` references are left pointing at CeraUI's origin, which would have
 * rendered a blank page even if the download had not happened.
 *
 * So the reading is SNIFFED, and only ever when the device stated nothing — a
 * dialect that named a type is byte-untouched, whatever it named. The prefixes
 * are the HTML rows of the WHATWG mimesniff table, which is what a browser
 * would itself have applied had `Bun.serve` not pre-empted it. No charset is
 * asserted: the document's own `<meta charset>` knows better than a sniff does,
 * and stating one here would override it.
 */
export function sniffAbsentContentType(body: string): string | undefined {
	const head = body.slice(0, 512).trimStart().toLowerCase();
	const isHtml = ["<!doctype html", "<html", "<head", "<body"].some((tag) =>
		head.startsWith(tag),
	);
	return isHtml ? "text/html" : undefined;
}

/**
 * Should this response body be URL-rewritten?
 *
 * Markup, stylesheets and scripts carry the navigable URLs an SPA needs
 * re-pointed. A DATA payload does not, and rewriting one corrupts it — which is
 * not hypothetical here: the HiLink API answers XML under a `text/html`
 * content-type, so the content-type alone would sweep every session token and
 * API document into the transform. An XML prolog is therefore treated as data
 * whatever the header claims, and JSON is excluded outright.
 */
export function shouldRewriteBody(
	contentType: string | undefined,
	body: string,
): boolean {
	if (!isRewritableContentType(contentType)) return false;
	return !body.trimStart().startsWith("<?xml");
}

/**
 * The CONTENT-TYPE half of {@link shouldRewriteBody}, asked on its own.
 *
 * Splitting it out is what lets the caller decide whether a body is worth
 * decoding at all: the remaining half needs the text, but a type that could
 * never be rewritten settles the question without one — and an admin UI's
 * images and fonts are most of its requests, so decoding each of them into a
 * throwaway UTF-8 string is a full copy of every byte for an answer already
 * known.
 */
export function isRewritableContentType(
	contentType: string | undefined,
): boolean {
	const type = (contentType ?? "").toLowerCase();
	return (
		type.includes("text/html") ||
		type.includes("text/css") ||
		type.includes("javascript") ||
		type.includes("text/plain")
	);
}

/**
 * Re-point the URLs of an opaque vendor admin UI onto the proxy prefix.
 *
 * THE HARD PART IS JAVASCRIPT, AND BOTH TRAPS WERE FOUND ON THE BOARD.
 *
 * A regex literal looks exactly like a path. `(` opens a CSS `url(…)` AND a JS
 * regex, so treating it as a delimiter everywhere rewrote `replace(/-/g, …)` in
 * the bench HiLink's `main.js`; the file still returned 200 and still parsed,
 * but defined nothing, and the page threw `create_button is not defined`. `(` is
 * therefore honoured in STYLESHEETS only.
 *
 * Quotes are not sufficient either, because a regex literal may END in one:
 * jQuery 1.7.2 contains `replace(/'/g, …)` and `/ jQuery\d+="(?:\d+|null)"/g`,
 * where a quote is immediately followed by `/g` — indistinguishable, character
 * for character, from a quoted path. Rewriting those produced
 * `SyntaxError: Invalid regular expression flags` and took jQuery out entirely.
 *
 * So outside CSS a root-relative reference is recognised only when it names a
 * DIRECTORY — `"/api/…"`, `"/html/…"` — which is what every absolute reference
 * these dongles actually publish looks like, and which no regex literal can
 * imitate (`/'/g` and `"/g` both fail it). A single-segment `"/index.html"`
 * is consequently left alone; that is the deliberate cost of not corrupting
 * scripts the device depends on.
 *
 * A DELIMITER FOLLOWED BY `/` IS NOT ENOUGH — the `/` must begin a real path
 * segment. XHTML closes a tag with `"/>`, and matching on the delimiter alone
 * rewrote every self-closing tag on the bench HiLink's own index into garbage
 * attributes (`content="…"/>` became `content="…" dongle-admin="" 1001="">`),
 * so the page parsed but rendered nothing. The lookahead is the fix: a path
 * character must follow. It also excludes a protocol-relative `//`, which names
 * another origin rather than a path here.
 *
 * A BARE `"/"` IS DELIBERATELY LEFT ALONE. It is indistinguishable from a
 * separator literal — `split('/')` is the same three characters as `href="/"` —
 * and mangling a script the device depends on is a far worse failure than one
 * root link that lands on CeraUI's own page instead.
 *
 * AN UNQUOTED ATTRIBUTE IS STILL AN ATTRIBUTE, AND A MINIFIER EMITS THEM.
 * Everything above keys on a QUOTE, which the UFI's index does not have: its
 * html-minifier output is `<link href=/static/css/app.css rel=stylesheet>` and
 * `<script src=/static/js/app.js>`, so every asset reference survived the
 * transform untouched and resolved against CeraUI's own origin. The extra pass
 * is deliberately NOT a bare `=` delimiter — `re=/foo/` is exactly that shape in
 * JavaScript, which is the same trap `(` was banned for. It is restricted to
 * `text/html` bodies AND to the fixed set of HTML attributes that are DEFINED to
 * hold a URL, so the only way to trip it is an inline script assigning a
 * directory-shaped regex literal to a variable literally named `href`/`src`/…
 *
 * A BUNDLER'S PUBLIC PATH IS THE ONE ASSEMBLED URL THAT CAN BE REACHED. The
 * module header's standing caveat — that a URL a script builds at runtime out of
 * fragments cannot be followed — is true in general and has exactly one
 * important exception, because the UFI's SPA is a webpack bundle: its runtime
 * carries a SINGLE literal public path (`n.p="/"`) and composes every lazy chunk
 * as `n.p + "static/js/" + id + hash`. Board-measured, that sent chunk 0 to
 * CeraUI's own origin root, which answered with CeraUI's index under a
 * `text/html` label, so the vendor SPA loaded its shell and mounted nothing.
 * Re-basing that ONE literal fixes every chunk it will ever assemble.
 *
 * It is gated on the body positively BEING a webpack runtime, not merely on it
 * being a script, so `.p="/"` in some unrelated vendor code is out of reach.
 *
 * ORDER IS LOAD-BEARING. The root-relative pass runs FIRST: collapsing the
 * absolute origin first turns `"http://<gw>/html"` into `"<base>/html"`, whose
 * leading `/` is then quote-delimited and gets prefixed a SECOND time. Run this
 * way round the absolute form is untouched by the regex (its first `/` follows
 * a `:`, not a delimiter) and each reference is rewritten exactly once.
 */
export function rewriteAdminBody(
	body: string,
	adminOrigin: string,
	base: string,
	contentType?: string,
): string {
	const type = (contentType ?? "").toLowerCase();
	const delimiters = type.includes("text/css")
		? /(["'(])\/(?=[A-Za-z0-9_\-.~%])/g
		: /(["'])\/(?=[A-Za-z0-9_][A-Za-z0-9_.-]*\/)/g;
	const quoted = body.replace(delimiters, `$1${base}/`);
	const attributed = type.includes("text/html")
		? quoted.replace(HTML_UNQUOTED_URL_ATTR_RE, `$1${base}/`)
		: quoted;
	const rebased = WEBPACK_RUNTIME_RE.test(attributed)
		? attributed.replace(WEBPACK_PUBLIC_PATH_RE, `$1$2${base}/$2`)
		: attributed;
	// `split`+`join` allocates an array over the WHOLE body, and the UFI's
	// vendor bundle is 918 KB of script that names the dongle's origin nowhere.
	// A scan that answers "not present" costs a fraction of the copy it skips.
	return rebased.includes(adminOrigin)
		? rebased.split(adminOrigin).join(base)
		: rebased;
}

/**
 * Response headers to hand back to the browser.
 *
 * `Location` is re-pointed so a redirect re-enters through the proxy and stays
 * bound to this interface. `Set-Cookie` has its `Path` rewritten to this
 * device's own prefix, which does double duty: it keeps a dongle's cookies off
 * the rest of CeraUI's origin, and it stops two identical twins — which issue
 * cookies of the same name — overwriting each other's session.
 */
export function rewriteResponseHeaders(
	parsed: ParsedAdminHeaders,
	adminOrigin: string,
	base: string,
): Headers {
	const out = new Headers();
	for (const [name, value] of parsed.headers) {
		const lower = name.toLowerCase();
		if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
		if (lower === "location") {
			out.set(name, rewriteAbsoluteUrl(value, adminOrigin, base));
			continue;
		}
		if (lower === "set-cookie") {
			out.append(name, rewriteCookiePath(value, base));
			continue;
		}
		out.append(name, value);
	}
	return out;
}

/** Force a `Set-Cookie`'s `Path` onto this device's proxy prefix. */
export function rewriteCookiePath(cookie: string, base: string): string {
	const parts = cookie.split(";").filter((part) => {
		const trimmed = part.trim().toLowerCase();
		return !trimmed.startsWith("path=") && !trimmed.startsWith("domain=");
	});
	parts.push(` Path=${base}/`);
	return parts.join(";");
}
