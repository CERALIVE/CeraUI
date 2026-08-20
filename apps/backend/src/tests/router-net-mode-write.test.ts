/**
 * Todo 22 STAGE B — the network-mode WRITE, and what gates it.
 *
 * Stage A shipped the READ that says what a firmware will discuss and shipped no
 * write for anyone. This is the write, and the whole of its safety is that it
 * asks the SAME question first: `/api/net/net-mode-list` either names a catalog
 * or refuses, and only the first arm may be written into. The bench unit refuses
 * with the vendor's own `112008`, so on that hardware this code path posts
 * NOTHING — which is asserted here rather than assumed, because "it would refuse"
 * and "it refused before touching the device" are different claims and only the
 * second is worth having.
 *
 * ── FIXTURE PROVENANCE ──────────────────────────────────────────────────────
 *
 * The `112008` CODE is a real bench measurement (phase-B todo 56's write-probe
 * table). The `<error>` envelope carrying it and the `<NetworkModeList>` document
 * are SHAPE-DERIVED from the HiLink dialect — the bench units are SIM-less, so no
 * capture exists in which a mode catalog is populated. Nothing here is labelled a
 * capture that is not one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	hilinkConnectionBody,
	hilinkNetModeBody,
} from "../modules/network/hilink-documents.ts";
import type { RouterAdminProbeDeps } from "../modules/network/router-cellular-admin.ts";
import { applyRouterNetMode } from "../modules/network/router-cellular-control.ts";

const BACKEND_SRC = join(import.meta.dir, "..");

const HILINK = "12d1:14dc";
const IFNAME = "enx0c5b8f279a64";
const ROUTES = `default via 192.168.8.1 dev ${IFNAME} proto dhcp metric 100\n`;

const SESSION = `<?xml version="1.0" encoding="UTF-8"?>
<response><SesInfo>SessionID=abc</SesInfo><TokInfo>token-1</TokInfo></response>`;

/** SHAPE-DERIVED: the firmware's own catalog, with real vendor indices. */
const CATALOG = `<?xml version="1.0" encoding="UTF-8"?>
<response><NetworkModeList>
<NetworkMode><Index>00</Index><Name>AUTO</Name></NetworkMode>
<NetworkMode><Index>03</Index><Name>LTE</Name></NetworkMode>
</NetworkModeList></response>`;

const netMode = (mode: string) =>
	`<?xml version="1.0" encoding="UTF-8"?>
<response><NetworkMode>${mode}</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800C5</LTEBand></response>`;

/** VERBATIM CODE, shape-derived envelope: what the bench unit answers. */
const REFUSED = `<?xml version="1.0" encoding="UTF-8"?>
<error><code>112008</code><message>ERROR</message></error>`;

type Recorded = { url: string; body: string };

/**
 * A HiLink that answers every URL from one table.
 *
 * `posts` is the assertion surface: an empty array is the ONLY way to prove a
 * refusal happened before the device was touched.
 */
function hilink(options: {
	readonly catalog: string;
	readonly current: string;
	/** The mode the device reports AFTER a write. Defaults to what was written. */
	readonly appliedOverride?: string;
}): {
	deps: RouterAdminProbeDeps;
	posts: Recorded[];
	sessions: () => number;
} {
	const posts: Recorded[] = [];
	let sessionCount = 0;
	let current = options.current;

	const deps: RouterAdminProbeDeps = {
		isRealDevice: () => Promise.resolve(true),
		runIpRouteShowDefault: () => Promise.resolve(ROUTES),
		fetchViaInterface: (_ifname, urls) =>
			Promise.resolve(
				urls.map((url) => {
					if (url.endsWith("/api/webserver/SesTokInfo")) {
						sessionCount += 1;
						return SESSION;
					}
					if (url.endsWith("/api/net/net-mode-list")) return options.catalog;
					if (url.endsWith("/api/net/net-mode")) return netMode(current);
					return "";
				}),
			),
		postViaInterface: (_ifname, url, body) => {
			posts.push({ url, body });
			if (url.endsWith("/api/net/net-mode")) {
				const requested = /<NetworkMode>([^<]*)<\/NetworkMode>/.exec(body)?.[1];
				current = options.appliedOverride ?? requested ?? current;
			}
			return Promise.resolve("<response>OK</response>");
		},
	};
	return { deps, posts, sessions: () => sessionCount };
}

describe("the capability decides, and it decides FIRST", () => {
	test("a firmware that refuses the question is never posted to", async () => {
		const unit = hilink({ catalog: REFUSED, current: "03" });

		const result = await applyRouterNetMode(IFNAME, HILINK, "03", unit.deps);

		expect(result).toEqual({
			status: "refused",
			reason: "capability_unavailable",
			code: "112008",
		});
		// The whole point of Stage B's gate: the bench unit's device was READ and
		// never WRITTEN, so a firmware with no writable mode cannot be moved by a
		// caller who insisted.
		expect(unit.posts).toEqual([]);
	});

	test("a session refusal is reported as the SESSION, not as the firmware", async () => {
		const authRefused = `<?xml version="1.0" encoding="UTF-8"?>
<error><code>125002</code><message>ERROR</message></error>`;
		const unit = hilink({ catalog: authRefused, current: "03" });

		const result = await applyRouterNetMode(IFNAME, HILINK, "03", unit.deps);

		// `auth-expired` carries no vendor code, so none is echoed — telling an
		// operator their dongle "refused with 125002" would blame the firmware for
		// a token problem.
		expect(result).toEqual({
			status: "refused",
			reason: "capability_unavailable",
		});
		expect(unit.posts).toEqual([]);
	});

	test("a mode the catalog does not contain is refused, not invented", async () => {
		const unit = hilink({ catalog: CATALOG, current: "00" });

		const result = await applyRouterNetMode(IFNAME, HILINK, "07", unit.deps);

		expect(result).toEqual({ status: "refused", reason: "not_offered" });
		expect(unit.posts).toEqual([]);
	});

	test("a dialect with no net-mode write reads nothing at all", async () => {
		const unit = hilink({ catalog: CATALOG, current: "00" });

		const result = await applyRouterNetMode(
			IFNAME,
			"19d2:1405",
			"03",
			unit.deps,
		);

		expect(result).toEqual({ status: "refused", reason: "unsupported" });
		expect(unit.posts).toEqual([]);
		expect(unit.sessions()).toBe(0);
	});
});

describe("a firmware that names its catalog IS writable", () => {
	test("applies the requested mode and reports the device's own re-read", async () => {
		const unit = hilink({ catalog: CATALOG, current: "00" });

		const result = await applyRouterNetMode(IFNAME, HILINK, "03", unit.deps);

		expect(result.status).toBe("applied");
		if (result.status !== "applied") throw new Error("unreachable");
		expect(result.capabilities.net_mode).toEqual({
			state: "reported",
			modes: [
				{ id: "00", name: "AUTO" },
				{ id: "03", name: "LTE" },
			],
			current: "03",
		});
	});

	test("REPLACES the record: the band masks are echoed, never defaulted", async () => {
		const unit = hilink({ catalog: CATALOG, current: "00" });

		await applyRouterNetMode(IFNAME, HILINK, "03", unit.deps);

		const written = unit.posts.at(0)?.body ?? "";
		expect(written).toContain("<NetworkMode>03</NetworkMode>");
		// `800C5` is the device's OWN LTE band mask. Posting the mode alone would
		// reset it to the firmware default and silently narrow the radio.
		expect(written).toContain("<LTEBand>800C5</LTEBand>");
		expect(written).toContain("<NetworkBand>3FFFFFFF</NetworkBand>");
	});

	test("the proof is a SECOND session — a HiLink token is single-use", async () => {
		const unit = hilink({ catalog: CATALOG, current: "00" });

		await applyRouterNetMode(IFNAME, HILINK, "03", unit.deps);

		// One for the capability read + write, one for the verification read.
		expect(unit.sessions()).toBe(2);
	});

	test("an OK that did not move the setting is refused, not reported applied", async () => {
		const unit = hilink({
			catalog: CATALOG,
			current: "00",
			appliedOverride: "00",
		});

		const result = await applyRouterNetMode(IFNAME, HILINK, "03", unit.deps);

		expect(result).toEqual({ status: "refused", reason: "not_applied" });
		expect(unit.posts).toHaveLength(1);
	});

	test("a device that stopped answering mid-write is unreachable, not applied", async () => {
		const unit = hilink({ catalog: CATALOG, current: "00" });
		const throwing: RouterAdminProbeDeps = {
			...unit.deps,
			postViaInterface: () => Promise.reject(new Error("connection reset")),
		};

		const result = await applyRouterNetMode(IFNAME, HILINK, "03", throwing);

		expect(result).toEqual({ status: "refused", reason: "unreachable" });
	});
});

describe("replace-not-patch is one rule, in one module", () => {
	test("the connection record echoes all five sibling fields", () => {
		const current =
			"<response><RoamAutoConnectEnable>0</RoamAutoConnectEnable>" +
			"<MaxIdelTime>1200</MaxIdelTime><ConnectMode>1</ConnectMode>" +
			"<MTU>1428</MTU><auto_dial_switch>0</auto_dial_switch>" +
			"<pdp_always_on>0</pdp_always_on></response>";

		const body = hilinkConnectionBody(current, true);

		expect(body).toContain("<RoamAutoConnectEnable>1</RoamAutoConnectEnable>");
		for (const echoed of [
			"<MaxIdelTime>1200</MaxIdelTime>",
			"<ConnectMode>1</ConnectMode>",
			"<MTU>1428</MTU>",
			"<auto_dial_switch>0</auto_dial_switch>",
			"<pdp_always_on>0</pdp_always_on>",
		]) {
			expect(body).toContain(echoed);
		}
	});

	test("a partial read falls back to all-bands, never to no-bands", () => {
		// The failure direction that keeps a radio usable: a device that answered
		// the mode but not the masks is widened, not narrowed to nothing.
		const body = hilinkNetModeBody(
			"<response><NetworkMode>00</NetworkMode></response>",
			"03",
		);

		expect(body).toContain("<NetworkBand>3FFFFFFF</NetworkBand>");
		expect(body).toContain("<LTEBand>7FFFFFFFFFFFFFFF</LTEBand>");
	});
});

describe("the READ modules gained no write, and that is now provable by location", () => {
	function stripComments(source: string): string {
		return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
	}

	function read(...parts: string[]): string {
		return stripComments(
			readFileSync(join(BACKEND_SRC, "modules", "network", ...parts), "utf8"),
		);
	}

	/**
	 * Stage A greped BOTH modules for a `<NetworkMode>` request document because
	 * neither was allowed to carry one. Stage B legitimately adds it — so the
	 * fence is RETARGETED rather than dropped, and it is strictly stronger: the
	 * write tokens must live ONLY in the write modules, which additionally proves
	 * the read path did not quietly grow one.
	 */
	test("the capability reader and the admin probe name no write document", () => {
		for (const name of ["router-capabilities.ts", "router-cellular-admin.ts"]) {
			const code = read(name);
			expect(code).not.toMatch(/<request>[\s\S]*NetworkMode/);
			expect(code).not.toContain("dhcp/settings");
			expect(code).not.toContain("DhcpIPAddress");
		}
	});

	test("…and the write documents live in the write module", () => {
		const documents = read("hilink-documents.ts");
		expect(documents).toMatch(/<request>[\s\S]*NetworkMode/);
		expect(documents).toContain("DhcpIPAddress");
	});

	test("the capability reader still exports nothing that could mutate a dongle", async () => {
		const module = await import("../modules/network/router-capabilities.ts");
		const mutating =
			/^(set|write|apply|send|post|configure|enable|disable|update|reset)/i;
		expect(Object.keys(module).filter((name) => mutating.test(name))).toEqual(
			[],
		);
	});
});
