import { beforeEach, describe, expect, test } from "bun:test";

import {
	buildAdminProxyArgv,
	dongleAdminBase,
	forwardableRequestHeaders,
	isRewritableContentType,
	parseAdminHeaderDump,
	parseDongleAdminPath,
	placeOnCpus,
	rewriteAbsoluteUrl,
	rewriteAdminBody,
	rewriteCookiePath,
	rewriteResponseHeaders,
	shouldRewriteBody,
	sniffAbsentContentType,
} from "../modules/network/router-admin-proxy.ts";
import {
	cachedDefaultRoutes,
	DEFAULT_ROUTE_CACHE_TTL_MS,
	type DongleAdminProxyDeps,
	handleDongleAdminRequest,
	invalidateDefaultRouteCache,
	type ProxyCurlResult,
	resolveDongleAdminTarget,
} from "../modules/ui/dongle-admin-proxy.ts";
import {
	cookiesForDongle,
	exchangeDongleAdminToken,
	isDongleAdminSession,
	mintDongleAdminToken,
	readCookie,
	resetDongleAdminSessions,
} from "../modules/ui/dongle-admin-session.ts";

const PREFIX = "/dongle-admin";

/*
  THE BENCH COLLISION, VERBATIM (ceralive2, 2026-08-18).

  `ip -4 route show default` on the board, for the two Huawei E3372 twins. Both
  units lease the host `192.168.8.100` and both publish `192.168.8.1` as the
  gateway — i.e. as their admin address. Every fixture below is this output, so
  a proxy that resolved by address rather than by interface cannot pass.

  Measured through each binding, the two答 with DIFFERENT serials:
    enx0c5b8f279a64 -> Y4QDU17621000872
    eth1            -> Y4QDU17621000793
*/
const BENCH_DEFAULT_ROUTES = [
	"default via 192.168.0.1 dev enx344b50000000 proto dhcp src 192.168.0.169 metric 103",
	"default via 192.168.8.1 dev eth1 proto dhcp src 192.168.8.100 metric 105",
	"default via 192.168.8.1 dev enx0c5b8f279a64 proto dhcp src 192.168.8.100 metric 106",
	"default via 192.168.78.1 dev eth0 proto dhcp src 192.168.78.132 metric 101",
	"default via 192.168.100.1 dev enx020a53313630 proto dhcp src 192.168.100.164 metric 107",
].join("\n");

/** Wire ids as the last projection allocated them for the bench roster. */
const TWIN_A = 7;
const TWIN_B = 8;
const ZTE = 9;
const UFI = 10;

const IFNAME_BY_ID: Record<number, string> = {
	[TWIN_A]: "enx0c5b8f279a64",
	[TWIN_B]: "eth1",
	[ZTE]: "enx344b50000000",
	[UFI]: "enx020a53313630",
};

/*
  THE QUALCOMM UFI's OWN INDEX, VERBATIM (ceralive2, 2026-08-18).

  `curl -D - --interface enx020a53313630 http://192.168.100.1/` — note the
  ABSENT `Content-Type`, and that the same firmware DOES send `text/html` for
  `/index.html`: it infers the type from the URL's file extension, so only the
  extensionless entry point is affected. The body is html-minifier output, so
  every attribute is unquoted.
*/
const UFI_ROOT_HEADERS = [
	"HTTP/1.1 200 OK",
	"Date: Fri Jan  2 00:46:28 1970",
	"Content-Length: 540",
	"Connection: keep-alive",
	"X-Frame-Options: SAMEORIGIN",
	"Last-Modified: Fri Dec 18 14:42:16 1903",
	"",
	"",
].join("\r\n");

const UFI_ROOT_BODY =
	"<!DOCTYPE html><html><head><meta charset=utf-8>" +
	'<meta name=viewport content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=0">' +
	"<title>4G UFI</title>" +
	"<link href=/static/css/app.b44cbf1559406604651b71cccb26d480.css rel=stylesheet>" +
	"</head><body><div id=app></div>" +
	"<script type=text/javascript src=/static/js/manifest.56e2448e47f5a482ad21.js></script>" +
	"<script type=text/javascript src=/static/js/vendor.a62624a3c1c9db857132.js></script>" +
	"<script type=text/javascript src=/static/js/app.2ecd2dc1119b817e8a1c.js></script>" +
	"</body></html>";

type Recorded = { argv: readonly string[]; body: Uint8Array | undefined };

function makeDeps(
	recorded: Recorded[],
	respond: (argv: readonly string[]) => ProxyCurlResult = () => ({
		stdout: new TextEncoder().encode("ok"),
		headerDump: "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n",
		exitCode: 0,
	}),
): DongleAdminProxyDeps {
	return {
		resolveIfname: (wireId) => IFNAME_BY_ID[wireId],
		runIpRouteShowDefault: async () => BENCH_DEFAULT_ROUTES,
		runCurl: async (argv, body) => {
			recorded.push({ argv, body });
			return respond(argv);
		},
	};
}

function bindingOf(argv: readonly string[]): string | undefined {
	const at = argv.indexOf("--interface");
	return at === -1 ? undefined : argv[at + 1];
}

beforeEach(() => {
	resetDongleAdminSessions();
	invalidateDefaultRouteCache();
});

describe("path routing", () => {
	test("a request names a DEVICE, and the tail is preserved verbatim", () => {
		expect(parseDongleAdminPath(`${PREFIX}/7/html/index.html`, PREFIX)).toEqual(
			{
				wireId: 7,
				rest: "/html/index.html",
			},
		);
		expect(parseDongleAdminPath(`${PREFIX}/7`, PREFIX)).toEqual({
			wireId: 7,
			rest: "/",
		});
		expect(parseDongleAdminPath(`${PREFIX}/7/`, PREFIX)).toEqual({
			wireId: 7,
			rest: "/",
		});
	});

	test("a non-numeric id is refused rather than coerced", () => {
		// `Number("")` is 0, which is a REAL wire id — coercion would silently
		// route a malformed path at whichever device holds id 0.
		expect(parseDongleAdminPath(`${PREFIX}//html`, PREFIX)).toBeUndefined();
		expect(parseDongleAdminPath(`${PREFIX}/abc/x`, PREFIX)).toBeUndefined();
		expect(parseDongleAdminPath("/preview", PREFIX)).toBeUndefined();
		expect(parseDongleAdminPath("/", PREFIX)).toBeUndefined();
	});
});

describe("the target is resolved by INTERFACE, never by address", () => {
	test("two twins sharing ONE address resolve to two DIFFERENT bindings", async () => {
		const deps = makeDeps([]);
		const a = await resolveDongleAdminTarget(TWIN_A, deps);
		const b = await resolveDongleAdminTarget(TWIN_B, deps);

		// The address is identical — which is exactly why it cannot be the key.
		expect(a?.adminOrigin).toBe("http://192.168.8.1");
		expect(b?.adminOrigin).toBe("http://192.168.8.1");
		expect(a?.adminOrigin).toBe(b?.adminOrigin as string);

		// The binding is not.
		expect(a?.ifname).toBe("enx0c5b8f279a64");
		expect(b?.ifname).toBe("eth1");
		expect(a?.ifname).not.toBe(b?.ifname as string);
	});

	test("the gateway is read from THAT interface's own route, not hardcoded", async () => {
		const deps = makeDeps([]);
		// The ZTE is on a different factory subnet; a hardcoded 192.168.8.1 would
		// have sent its traffic to the twins' address.
		expect((await resolveDongleAdminTarget(ZTE, deps))?.adminOrigin).toBe(
			"http://192.168.0.1",
		);
	});

	test("an unresolvable id or a lease-less interface answers nothing", async () => {
		const deps = makeDeps([]);
		expect(await resolveDongleAdminTarget(404, deps)).toBeUndefined();
		expect(
			await resolveDongleAdminTarget(TWIN_A, {
				...deps,
				runIpRouteShowDefault: async () => "",
			}),
		).toBeUndefined();
		expect(
			await resolveDongleAdminTarget(TWIN_A, {
				...deps,
				runIpRouteShowDefault: async () => {
					throw new Error("ip failed");
				},
			}),
		).toBeUndefined();
	});
});

describe("the outbound request carries the binding", () => {
	test("the ifname reaches argv as its OWN --interface element", () => {
		const argv = buildAdminProxyArgv(
			"eth1",
			"http://192.168.8.1/api/device/information",
			"GET",
			[],
		);
		const at = argv.indexOf("--interface");
		expect(at).toBeGreaterThan(-1);
		expect(argv[at + 1]).toBe("eth1");
		// A redirect must come BACK to the browser so it re-enters through the
		// proxy and stays bound, rather than being followed here unbound.
		expect(argv).toContain("--no-location");
		// Header capture is the RUNTIME's concern (a Bun pipe cannot carry it),
		// so the contract argv must not pin a mechanism.
		expect(argv).not.toContain("--dump-header");
		// The dongle serves pre-gzipped assets regardless of what we ask for, so
		// curl must decode them or the browser gets gzip under a JS label.
		expect(argv).toContain("--compressed");
	});

	test("a suspect ifname or method is refused before any spawn", () => {
		expect(() =>
			buildAdminProxyArgv("--upload-file", "http://x/", "GET", []),
		).toThrow();
		expect(() =>
			buildAdminProxyArgv("eth1", "http://x/", "GET; rm -rf /", []),
		).toThrow();
	});

	test("END TO END: each twin's request goes out its OWN interface", async () => {
		const recorded: Recorded[] = [];
		const deps = makeDeps(recorded);
		const session = openSession();

		await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${TWIN_A}/api/device/information`, session),
			deps,
		);
		await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${TWIN_B}/api/device/information`, session),
			deps,
		);

		expect(recorded).toHaveLength(2);
		expect(bindingOf(recorded[0]?.argv ?? [])).toBe("enx0c5b8f279a64");
		expect(bindingOf(recorded[1]?.argv ?? [])).toBe("eth1");

		// Both dialled the SAME address. Only the binding told them apart, which
		// is the entire correctness claim of this module.
		const urls = recorded.map((r) => r.argv[r.argv.length - 1]);
		expect(urls[0]).toBe("http://192.168.8.1/api/device/information");
		expect(urls[1]).toBe(urls[0] as string);
	});
});

function openSession(): string {
	const token = mintDongleAdminToken();
	const session = exchangeDongleAdminToken(token);
	if (session === undefined) throw new Error("failed to open a test session");
	return session;
}

function adminRequest(
	path: string,
	session?: string,
	init?: RequestInit,
): Request {
	const headers = new Headers(init?.headers);
	if (session !== undefined) {
		headers.set("cookie", `ceraui_dongle_admin=${session}`);
	}
	return new Request(`http://device.local${path}`, { ...init, headers });
}

describe("authentication", () => {
	test("no session is refused, and the proxy is never dialled", async () => {
		const recorded: Recorded[] = [];
		const res = await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${TWIN_A}/`),
			makeDeps(recorded),
		);
		expect(res?.status).toBe(401);
		expect(recorded).toHaveLength(0);
	});

	test("a token is exchanged ONCE for a scoped cookie and then redirected away", async () => {
		const token = mintDongleAdminToken();
		const res = await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${TWIN_A}/?dongle_token=${token}`),
			makeDeps([]),
		);
		expect(res?.status).toBe(302);
		// The spent token must not linger in history or in a referrer the dongle
		// would see.
		expect(res?.headers.get("location")).toBe(`${PREFIX}/${TWIN_A}/`);
		const cookie = res?.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain(`Path=${PREFIX}`);

		// Single use: presenting it a second time opens nothing.
		const replay = await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${TWIN_A}/?dongle_token=${token}`),
			makeDeps([]),
		);
		expect(replay?.status).toBe(401);
	});

	test("an expired token opens no session", () => {
		const now = 1_000_000;
		const token = mintDongleAdminToken(now);
		expect(exchangeDongleAdminToken(token, now + 60_000)).toBeUndefined();
	});

	test("a session expires, and an unknown one was never valid", () => {
		const now = 1_000_000;
		const session = exchangeDongleAdminToken(mintDongleAdminToken(now), now);
		expect(isDongleAdminSession(session, now + 1_000)).toBe(true);
		expect(isDongleAdminSession(session, now + 60 * 60_000)).toBe(false);
		expect(isDongleAdminSession("nope", now)).toBe(false);
		expect(isDongleAdminSession(undefined, now)).toBe(false);
	});

	test("a path that is not ours falls through untouched", async () => {
		expect(
			await handleDongleAdminRequest(adminRequest("/status"), makeDeps([])),
		).toBeNull();
	});
});

describe("what the browser is handed back", () => {
	const base = dongleAdminBase(PREFIX, TWIN_A);
	const origin = "http://192.168.8.1";

	test("curl's header dump keeps only the block that carried the body", () => {
		const parsed = parseAdminHeaderDump(
			"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 307 Temporary Redirect\r\nLocation: http://192.168.8.1/html/index.html\r\nX-Frame-Options: deny\r\n",
		);
		expect(parsed.status).toBe(307);
		expect(parsed.headers).toContainEqual([
			"Location",
			"http://192.168.8.1/html/index.html",
		]);
	});

	test("the bench HiLink's real redirect re-enters through the proxy", () => {
		// Verbatim from the board: both twins answer this on `/`.
		const parsed = parseAdminHeaderDump(
			[
				"HTTP/1.1 307 Temporary Redirect",
				"Server: WebServer",
				"X-Frame-Options: deny",
				"Strict-Transport-Security: max-age=31536000; includeSubdomains",
				"Location: http://192.168.8.1/html/index.html",
				"Content-Encoding: gzip",
				"Content-Length: 13",
				"",
			].join("\r\n"),
		);
		const headers = rewriteResponseHeaders(parsed, origin, base);
		expect(headers.get("location")).toBe(`${base}/html/index.html`);

		// A dongle must not dictate framing or transport policy for the DEVICE's
		// own origin — an HSTS pin here would lock an operator out of a board
		// that legitimately serves plain HTTP on the LAN.
		expect(headers.get("x-frame-options")).toBeNull();
		expect(headers.get("strict-transport-security")).toBeNull();
		// The body may be rewritten, so the upstream length must not be replayed —
		// and curl already decoded the payload, so the upstream encoding must not
		// be replayed either.
		expect(headers.get("content-length")).toBeNull();
		expect(headers.get("content-encoding")).toBeNull();
	});

	test("a dongle cookie is confined to that ONE device's prefix", () => {
		// Two identical twins issue cookies of the SAME name; without a per-device
		// path they would overwrite each other's session.
		expect(rewriteCookiePath("SessionID=abc; Path=/; HttpOnly", base)).toBe(
			`SessionID=abc; HttpOnly; Path=${base}/`,
		);
		expect(
			rewriteCookiePath("SessionID=abc", dongleAdminBase(PREFIX, TWIN_B)),
		).toContain(`Path=${PREFIX}/${TWIN_B}/`);
	});

	test("markup and scripts are re-pointed onto the device's prefix", () => {
		expect(rewriteAdminBody('<script src="/js/app.js">', origin, base)).toBe(
			`<script src="${base}/js/app.js">`,
		);
		expect(
			rewriteAdminBody("url(/img/logo.png)", origin, base, "text/css"),
		).toBe(`url(${base}/img/logo.png)`);
		expect(
			rewriteAdminBody(`fetch('/api/monitoring/status')`, origin, base),
		).toBe(`fetch('${base}/api/monitoring/status')`);
		expect(
			rewriteAdminBody(`<a href="${origin}/html/home">`, origin, base),
		).toBe(`<a href="${base}/html/home">`);
		// A protocol-relative URL names another origin, not a path here.
		expect(rewriteAdminBody('<img src="//cdn/x.png">', origin, base)).toBe(
			'<img src="//cdn/x.png">',
		);
	});

	test("an XHTML self-closing tag is NOT mistaken for a path", () => {
		// The bench HiLink's own index is XHTML. Matching on the delimiter alone
		// turned every `"/>` into attributes and the page rendered blank while
		// still returning 200 — found on the board, not in a fixture.
		const meta =
			'<meta name="csrf_token" content="BpVE+3uiUQu2VsqVMaJNV6txlzi7p1Ha"/>';
		expect(rewriteAdminBody(meta, origin, base)).toBe(meta);
		expect(rewriteAdminBody("<br />", origin, base)).toBe("<br />");
		// …while a real path in the SAME document is still rewritten.
		expect(
			rewriteAdminBody(
				`${meta}<script src="/js/app.js"></script>`,
				origin,
				base,
			),
		).toBe(`${meta}<script src="${base}/js/app.js"></script>`);
	});

	test("a JS REGEX LITERAL is never mistaken for a path", () => {
		// `(` opens a CSS `url(…)` AND a JS regex literal. Treating it as a path
		// delimiter in scripts rewrote `replace(/-/g, …)` inside the bench
		// HiLink's `main.js`, which then defined nothing and threw
		// `create_button is not defined` — a 200 that rendered a blank page.
		const js = `x.replace(/-/g, "_").replace(/SIM/g, "sim")`;
		expect(rewriteAdminBody(js, origin, base)).toBe(js);
		expect(rewriteAdminBody(js, origin, base, "application/javascript")).toBe(
			js,
		);
		// The HARDER case: a regex literal that ENDS in a quote. Both of these are
		// verbatim from the jQuery 1.7.2 the bench dongle ships, and rewriting
		// either produced `Invalid regular expression flags` — which took jQuery
		// out entirely and left every page blank.
		const jq = `l?n=n.replace(/'/g,"\\\\$&"):e.setAttribute("x")`;
		expect(rewriteAdminBody(jq, origin, base, "application/javascript")).toBe(
			jq,
		);
		const jq2 = `W=/ jQuery\\\\d+="(?:\\\\d+|null)"/g,X=/^\\\\s+/`;
		expect(rewriteAdminBody(jq2, origin, base, "application/javascript")).toBe(
			jq2,
		);
		// jQuery's own single-segment feature probe, deliberately untouched.
		const probe = `a.innerHTML="<a href='/a' style='top:1px'></a>"`;
		expect(rewriteAdminBody(probe, origin, base, "text/html")).toBe(probe);

		// …and a real quoted path in the SAME script is still rewritten.
		expect(
			rewriteAdminBody(
				`fetch("/api/x");${js}`,
				origin,
				base,
				"application/javascript",
			),
		).toBe(`fetch("${base}/api/x");${js}`);
		// The real thing, verbatim from the bench HiLink's own `main.js`.
		expect(
			rewriteAdminBody(
				`$.get('/api/user/login')`,
				origin,
				base,
				"application/javascript",
			),
		).toBe(`$.get('${base}/api/user/login')`);
		// A stylesheet still gets its `url(…)` rewritten.
		expect(
			rewriteAdminBody("a{background:url(/i.png)}", origin, base, "text/css"),
		).toBe(`a{background:url(${base}/i.png)}`);
	});

	test("a separator literal is left alone, and so is a bare root", () => {
		// `split('/')` and `href="/"` are the SAME three characters, so neither is
		// rewritten: mangling a script the device runs on is a worse failure than
		// one root link landing on CeraUI's own page.
		expect(rewriteAdminBody(`x.split('/')`, origin, base)).toBe(`x.split('/')`);
		expect(rewriteAdminBody('<a href="/">home</a>', origin, base)).toBe(
			'<a href="/">home</a>',
		);
	});

	test("a DATA payload is never rewritten, whatever the content-type claims", () => {
		// The HiLink API answers XML under `text/html`, so the header alone would
		// sweep every session token and API document into the transform.
		const xml =
			'<?xml version="1.0" encoding="UTF-8"?>\n<response><SesInfo>SessionID=a/b/c</SesInfo></response>';
		expect(shouldRewriteBody("text/html", xml)).toBe(false);
		expect(shouldRewriteBody("application/json", '{"a":"/b"}')).toBe(false);
		expect(shouldRewriteBody("image/png", "\u0089PNG")).toBe(false);
		expect(shouldRewriteBody("text/html", "<html><body>")).toBe(true);
		expect(shouldRewriteBody("application/javascript", 'x="/a"')).toBe(true);
	});

	test("an absolute URL to another origin is left alone", () => {
		expect(rewriteAbsoluteUrl("http://example.com/x", origin, base)).toBe(
			"http://example.com/x",
		);
		expect(rewriteAbsoluteUrl("//cdn/x", origin, base)).toBe("//cdn/x");
	});
});

describe("a dongle that states NO content-type still RENDERS", () => {
	const base = dongleAdminBase(PREFIX, UFI);
	const origin = "http://192.168.100.1";

	test("the UFI's own index sniffs as HTML; anything else stays unstated", () => {
		expect(sniffAbsentContentType(UFI_ROOT_BODY)).toBe("text/html");
		expect(sniffAbsentContentType("\n  <html><body>hi")).toBe("text/html");
		expect(sniffAbsentContentType("<HEAD>")).toBe("text/html");
		// Nothing else is guessed at: a body we cannot positively identify keeps
		// whatever the transport decides, exactly as before this rule existed.
		expect(sniffAbsentContentType('{"reply":"ok"}')).toBeUndefined();
		expect(sniffAbsentContentType("var a=1;")).toBeUndefined();
		expect(sniffAbsentContentType("\u0089PNG\r\n")).toBeUndefined();
		expect(sniffAbsentContentType("")).toBeUndefined();
	});

	test("END TO END: the UFI's root is served as HTML, not as a download", async () => {
		const res = await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${UFI}/`, openSession()),
			makeDeps([], () => ({
				stdout: new TextEncoder().encode(UFI_ROOT_BODY),
				headerDump: UFI_ROOT_HEADERS,
				exitCode: 0,
			})),
		);

		expect(res?.status).toBe(200);
		// Absent upstream, `Bun.serve` would label this `application/octet-stream`
		// and the browser would DOWNLOAD the admin page — the reported bug.
		expect(res?.headers.get("content-type")).toBe("text/html");
		expect(res?.headers.get("content-disposition")).toBeNull();

		// …and because it is now typed, its own assets are re-pointed too. Left
		// unrewritten they resolve against CeraUI's origin and the page is blank,
		// so the download and the blank page were ONE defect.
		const html = await res?.text();
		expect(html).toContain(
			`href=${base}/static/css/app.b44cbf1559406604651b71cccb26d480.css`,
		);
		expect(html).toContain(
			`src=${base}/static/js/manifest.56e2448e47f5a482ad21.js`,
		);
		expect(html).not.toContain("=/static/");
	});

	test("a dongle that DID state a type is byte-untouched", async () => {
		// Suppression-only: the sniff can never overrule the device's own word,
		// so ZTE and Huawei — which both redirect `/` to an explicit `.html` and
		// always send a type — cannot be reached by this rule at all.
		const stated = await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${ZTE}/index.html`, openSession()),
			makeDeps([], () => ({
				stdout: new TextEncoder().encode("<html><body>zte</body></html>"),
				headerDump:
					"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Frame-Options: sameorigin\r\n\r\n",
				exitCode: 0,
			})),
		);
		expect(stated?.headers.get("content-type")).toBe("text/html");

		const binary = await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${ZTE}/fw.bin`, openSession()),
			makeDeps([], () => ({
				stdout: new TextEncoder().encode("<html>not really</html>"),
				headerDump:
					"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n",
				exitCode: 0,
			})),
		);
		expect(binary?.headers.get("content-type")).toBe(
			"application/octet-stream",
		);
		expect(await binary?.text()).toBe("<html>not really</html>");
	});

	test("an UNQUOTED HTML attribute is rewritten; a regex literal is not", () => {
		expect(
			rewriteAdminBody("<link href=/static/a.css>", origin, base, "text/html"),
		).toBe(`<link href=${base}/static/a.css>`);
		expect(
			rewriteAdminBody("<img src=/i/logo.png>", origin, base, "text/html"),
		).toBe(`<img src=${base}/i/logo.png>`);

		// A single-segment target names no directory, so it stays put — the same
		// refusal the quoted rule makes, for the same reason.
		expect(
			rewriteAdminBody("<a href=/index.html>", origin, base, "text/html"),
		).toBe("<a href=/index.html>");

		// The pass runs for MARKUP only, so a script body cannot reach it however
		// its variables are named…
		const js = `var src=/static/g,href=/js/g`;
		expect(rewriteAdminBody(js, origin, base, "application/javascript")).toBe(
			js,
		);
		// …and an attribute name that does not hold a URL is not a delimiter.
		expect(
			rewriteAdminBody("<b data-x=/static/y/>", origin, base, "text/html"),
		).toBe("<b data-x=/static/y/>");
	});

	test("a webpack runtime's public path is re-based, so LAZY chunks land", () => {
		// Verbatim tail of the UFI's own `manifest.js`. Its chunk URL is
		// `n.p+"static/js/"+id+hash`, assembled at runtime — so leaving `n.p`
		// alone sent chunk 0 to CeraUI's origin root, which answered with
		// CeraUI's own index and the vendor SPA mounted nothing.
		const runtime = `i.src=n.p+"static/js/"+e+"."+{0:"9604018a"}[e]+".js";n.m=e,n.p="/",n.oe=function(e){throw e}`;
		const rebased = rewriteAdminBody(
			`window.webpackJsonp=function(){};${runtime}`,
			origin,
			base,
			"application/x-javascript",
		);
		expect(rebased).toContain(`n.p="${base}/"`);
		// The composition template itself is untouched — only the base moved.
		expect(rebased).toContain(`n.p+"static/js/"`);

		// A script that is not a bundler runtime keeps its own `.p`, so an
		// unrelated property assignment can never be re-based by accident.
		const plain = `a.p="/",b.p = '/'`;
		expect(
			rewriteAdminBody(plain, origin, base, "application/javascript"),
		).toBe(plain);
		// And a longer path is left to the ordinary quoted rule, not this one.
		expect(
			rewriteAdminBody(
				`__webpack_require__;x.p="/static/"`,
				origin,
				base,
				"application/javascript",
			),
		).toBe(`__webpack_require__;x.p="${base}/static/"`);
	});
});

describe("what the dongle is told", () => {
	test("CeraUI's own session cookies never reach the dongle", () => {
		expect(
			cookiesForDongle(
				"session=ceraui-secret; SessionID=dongle; ceraui_dongle_admin=x",
			),
		).toBe("SessionID=dongle");
		expect(cookiesForDongle(null)).toBe("");
	});

	test("readCookie picks the exact name", () => {
		expect(
			readCookie("a=1; ceraui_dongle_admin=xyz", "ceraui_dongle_admin"),
		).toBe("xyz");
		expect(
			readCookie("not_ceraui_dongle_admin=xyz", "ceraui_dongle_admin"),
		).toBeUndefined();
		expect(readCookie(null, "ceraui_dongle_admin")).toBeUndefined();
	});

	test("hop-by-hop headers are dropped and encoding is left to curl", () => {
		const headers = forwardableRequestHeaders(
			[
				["host", "device.local"],
				["accept-encoding", "gzip"],
				["content-length", "10"],
				["user-agent", "Firefox"],
			],
			"SessionID=dongle",
		);
		expect(headers).toContain("user-agent: Firefox");
		expect(headers).toContain("Cookie: SessionID=dongle");
		expect(headers.some((h) => h.toLowerCase().startsWith("host:"))).toBe(
			false,
		);
		// curl's `--compressed` owns the encoding negotiation; a header set here
		// would override it and leave curl unable to decode the reply.
		expect(
			headers.filter((h) => h.toLowerCase().startsWith("accept-encoding:")),
		).toHaveLength(0);
	});
});

describe("failure is reported, never guessed", () => {
	test("an unresolvable device answers 502 and dials nothing", async () => {
		const recorded: Recorded[] = [];
		const res = await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/404/`, openSession()),
			makeDeps(recorded),
		);
		expect(res?.status).toBe(502);
		expect(recorded).toHaveLength(0);
	});

	test("a failed transfer answers 502 rather than an empty page", async () => {
		const res = await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${TWIN_A}/`, openSession()),
			makeDeps([], () => ({
				stdout: new Uint8Array(),
				headerDump: "",
				exitCode: 7,
			})),
		);
		expect(res?.status).toBe(502);
	});
});

/*
  BOARD-MEASURED COST OF ONE PROXIED ASSET (ceralive2, 2026-08-19), against a
  ZTE MF79U that answers its own HTTP in 5.3 ms (`curl -w time_total`):

    curl process startup .......... ~24 ms   (`curl --version`, no network at all)
    `ip -4 route show default` ....  ~4 ms   (spawned once PER ASSET)
    CeraUI request handling ....... ~3-6 ms
    the dongle's own answer ........  ~5 ms
                                    ------
    total .......................... ~36-40 ms

  So roughly seven eighths of every request was CeraUI-side process overhead.
  The three suites below pin the parts of that this proxy can remove without
  touching the binding that decides WHICH physical unit answers.
*/
describe("an asset burst pays for ONE routing read, not one per asset", () => {
	test("the route table is reused, and re-read once invalidated", async () => {
		let reads = 0;
		const read = async (): Promise<string> => {
			reads += 1;
			return BENCH_DEFAULT_ROUTES;
		};

		for (let i = 0; i < 40; i++) {
			expect(await cachedDefaultRoutes(read)).toBe(BENCH_DEFAULT_ROUTES);
		}
		expect(reads).toBe(1);

		invalidateDefaultRouteCache();
		expect(await cachedDefaultRoutes(read)).toBe(BENCH_DEFAULT_ROUTES);
		expect(reads).toBe(2);
	});

	test("the window is a BURST, not a session", () => {
		// Long enough to cover a page's asset storm, short enough that a
		// re-subnetted dongle is re-read within seconds rather than minutes.
		expect(DEFAULT_ROUTE_CACHE_TTL_MS).toBeGreaterThan(0);
		expect(DEFAULT_ROUTE_CACHE_TTL_MS).toBeLessThanOrEqual(10_000);
	});

	test("the WIRE-ID to INTERFACE mapping is never cached with it", async () => {
		// The twins ship ONE factory MAC and rename against each other on
		// replug, so a cached binding would send one unit's traffic to the
		// other. Only the ROUTE TABLE is reused; the binding is re-resolved on
		// every request and follows a re-mapping immediately.
		let reads = 0;
		const mapping: Record<number, string> = { [TWIN_A]: "enx0c5b8f279a64" };
		const deps: DongleAdminProxyDeps = {
			resolveIfname: (wireId) => mapping[wireId],
			runIpRouteShowDefault: async () => {
				reads += 1;
				return BENCH_DEFAULT_ROUTES;
			},
			runCurl: async () => ({
				stdout: new Uint8Array(),
				headerDump: "HTTP/1.1 200 OK\r\n\r\n",
				exitCode: 0,
			}),
		};
		const cachedDeps: DongleAdminProxyDeps = {
			...deps,
			runIpRouteShowDefault: () =>
				cachedDefaultRoutes(deps.runIpRouteShowDefault),
		};

		expect((await resolveDongleAdminTarget(TWIN_A, cachedDeps))?.ifname).toBe(
			"enx0c5b8f279a64",
		);
		mapping[TWIN_A] = "eth1";
		const after = await resolveDongleAdminTarget(TWIN_A, cachedDeps);

		expect(after?.ifname).toBe("eth1");
		expect(reads).toBe(1);
	});

	test("a failed transfer drops the cache so a moved dongle self-heals", async () => {
		let reads = 0;
		const read = async (): Promise<string> => {
			reads += 1;
			return BENCH_DEFAULT_ROUTES;
		};
		await cachedDefaultRoutes(read);
		expect(reads).toBe(1);

		const res = await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${TWIN_A}/`, openSession()),
			makeDeps([], () => ({
				stdout: new Uint8Array(),
				headerDump: "",
				exitCode: 7,
			})),
		);
		expect(res?.status).toBe(502);

		await cachedDefaultRoutes(read);
		expect(reads).toBe(2);
	});
});

describe("a short-lived client is placed where it starts fastest", () => {
	const ARGV = buildAdminProxyArgv("eth1", "http://192.168.8.1/x", "GET", []);

	test("a uniform machine builds the byte-identical argv", () => {
		expect(placeOnCpus(ARGV, undefined)).toEqual([...ARGV]);
		expect(placeOnCpus(ARGV, "")).toEqual([...ARGV]);
		expect(placeOnCpus(ARGV, undefined)).not.toContain("taskset");
	});

	test("a heterogeneous machine prefixes the placement and keeps the binding", () => {
		const placed = placeOnCpus(ARGV, "4,5,6,7");

		expect(placed.slice(0, 3)).toEqual(["taskset", "-c", "4,5,6,7"]);
		// The binding is what names the physical unit; a placement prefix must
		// leave it untouched, as its own argv element.
		expect(bindingOf(placed)).toBe("eth1");
		expect(placed.slice(3)).toEqual([...ARGV]);
	});

	test("a suspect CPU list is refused rather than silently ignored", () => {
		expect(() => placeOnCpus(ARGV, "4;reboot")).toThrow();
		expect(() => placeOnCpus(ARGV, "all")).toThrow();
		expect(() => placeOnCpus(ARGV, "-c 4")).toThrow();
	});
});

describe("a body that cannot be rewritten is never decoded", () => {
	/** 2 KiB that is NOT valid UTF-8 — a decode would not survive it intact. */
	const BINARY = Uint8Array.from({ length: 2048 }, (_, i) =>
		i < 8 ? ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i] ?? 0) : 0xff,
	);

	test("the content-type alone settles it", () => {
		expect(isRewritableContentType("text/html; charset=utf-8")).toBe(true);
		expect(isRewritableContentType("text/css")).toBe(true);
		expect(isRewritableContentType("application/x-javascript")).toBe(true);
		expect(isRewritableContentType("text/plain")).toBe(true);
		expect(isRewritableContentType("image/png")).toBe(false);
		expect(isRewritableContentType("font/woff")).toBe(false);
		expect(isRewritableContentType("application/json")).toBe(false);
		expect(isRewritableContentType(undefined)).toBe(false);
	});

	test("a stated-binary body is forwarded byte-for-byte", async () => {
		const res = await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${ZTE}/img/logo.png`, openSession()),
			makeDeps([], () => ({
				stdout: BINARY,
				headerDump: "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n\r\n",
				exitCode: 0,
			})),
		);
		expect(res?.status).toBe(200);
		expect(new Uint8Array(await (res as Response).arrayBuffer())).toEqual(
			BINARY,
		);
	});

	test("a content-type-less BINARY body is not sniffed into HTML", async () => {
		const res = await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${ZTE}/blob`, openSession()),
			makeDeps([], () => ({
				stdout: BINARY,
				headerDump: "HTTP/1.1 200 OK\r\n\r\n",
				exitCode: 0,
			})),
		);
		expect(res?.headers.get("content-type")).not.toBe("text/html");
		expect(new Uint8Array(await (res as Response).arrayBuffer())).toEqual(
			BINARY,
		);
	});

	test("a content-type-less HTML document LONGER than the sniff prefix still renders", async () => {
		// The sniff reads a bounded prefix now; a document whose markup runs
		// well past it must still be served as HTML and still be rewritten, or
		// the UFI's extensionless index downloads instead of loading.
		const html = `<!DOCTYPE html><html><head>${"<!-- pad -->".repeat(
			200,
		)}</head><body><script src="/static/js/app.js"></script></body></html>`;
		expect(html.length).toBeGreaterThan(512);

		const res = await handleDongleAdminRequest(
			adminRequest(`${PREFIX}/${UFI}/`, openSession()),
			makeDeps([], () => ({
				stdout: new TextEncoder().encode(html),
				headerDump: "HTTP/1.1 200 OK\r\n\r\n",
				exitCode: 0,
			})),
		);

		expect(res?.headers.get("content-type")).toBe("text/html");
		expect(await (res as Response).text()).toContain(
			`src="${PREFIX}/${UFI}/static/js/app.js"`,
		);
	});

	test("a body that never names the dongle's origin is returned unchanged", () => {
		const body = "var a = 1; // nothing addressable in here at all";
		expect(
			rewriteAdminBody(body, "http://192.168.8.1", `${PREFIX}/${TWIN_A}`),
		).toBe(body);
	});
});
