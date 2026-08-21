/*
 * HiLink capability DISCOVERY, read before anything is offered (todo 22, STAGE A).
 *
 * Todo 20 shipped `/api/net/net-mode` as a non-control: the bench unit answered
 * error `112008` rather than applying the write, so its success could not be
 * observed and no switch was rendered. That left the operator with no statement
 * at all about the dongle's radio-mode selection — neither the modes the
 * firmware advertises nor the fact that this one refuses to move between them.
 *
 * Three properties are the point of this file, and each is asserted rather than
 * described:
 *
 *  1. DISCOVERY RIDES THE ONE EXISTING REQUEST. `net-mode-list` and `net-mode`
 *     are appended to the URL list `probeHilink` already spawns ONE `curl` for,
 *     so the module's slowest probe does not grow a round-trip, and the per-unit
 *     `--interface` binding is unchanged — which is the only thing that keeps
 *     the twin HiLinks' two readings apart at all.
 *  2. A REFUSAL IS REPORTED AS A REFUSAL. The verbatim `112008` document
 *     resolves to a capability the operator can read, never to a fabricated
 *     catalog and never to silence.
 *  3. STAGE A SHIPS NO NET-MODE WRITE. `/api/net/net-mode` is GET-only here, no
 *     control names it, and the fence is behavioural AND structural.
 *
 * Fixture provenance: the `112008` refusal CODE is the bench measurement
 * recorded in `.omo/notepads/modem-stack-phase-b/learnings.md` (todo 56's
 * write-probe table). The `<error>` envelope carrying it, and the
 * `<NetworkModeList>` document, are SHAPE-DERIVED from the HiLink dialect this
 * module already parses — the bench units are SIM-less, so no capture exists in
 * which a mode catalog is populated. Where a body IS a verbatim capture it says
 * so on the constant.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as routerCapabilities from "../modules/network/router-capabilities.ts";
import {
	parseHilinkCapabilities,
	parseHilinkNetModeList,
} from "../modules/network/router-capabilities.ts";
import {
	parseHilink,
	probeRouterCellularAdmin,
	type RouterAdminProbeDeps,
} from "../modules/network/router-cellular-admin.ts";

const BACKEND_SRC = join(import.meta.dir, "..");

// ── fixtures ────────────────────────────────────────────────────────────────

/** VERBATIM (phase-B): the bench board's own default routes. */
const ROUTE_OUTPUT =
	"default via 192.168.8.1 dev enx0c5b8f279a64 proto dhcp src 192.168.8.100 metric 104\ndefault via 192.168.8.1 dev eth1 proto dhcp src 192.168.8.100 metric 105";

const SESSION =
	"<response><SesInfo>SessionID=abc</SesInfo><TokInfo>tok</TokInfo></response>";

/** VERBATIM (phase-B): the SIM-less E3372's `/api/device/information`. */
const HILINK_INFORMATION = `<?xml version="1.0" encoding="UTF-8"?>
<response>
<DeviceName>E3372</DeviceName>
<SerialNumber>Y4QDU17621000793</SerialNumber>
<SoftwareVersion>22.333.01.00.00</SoftwareVersion>
</response>`;

/** VERBATIM (phase-B): the same unit's `/api/monitoring/status`. */
const HILINK_STATUS = `<?xml version="1.0" encoding="UTF-8"?>
<response>
<ConnectionStatus>902</ConnectionStatus>
<SimStatus>255</SimStatus>
<SignalIcon>0</SignalIcon>
<maxsignal>5</maxsignal>
</response>`;

/** SHAPE-DERIVED: the HiLink `<NetworkModeList>` document, with real vendor indices. */
const NET_MODE_LIST = `<?xml version="1.0" encoding="UTF-8"?>
<response>
<NetworkModeList>
<NetworkMode>
<Index>00</Index>
<Name>AUTO</Name>
</NetworkMode>
<NetworkMode>
<Index>01</Index>
<Name>2G ONLY</Name>
</NetworkMode>
<NetworkMode>
<Index>03</Index>
<Name>LTE ONLY</Name>
</NetworkMode>
</NetworkModeList>
</response>`;

/** SHAPE-DERIVED: `/api/net/net-mode`, whose `<NetworkMode>` is a SCALAR here. */
const NET_MODE_CURRENT = `<?xml version="1.0" encoding="UTF-8"?>
<response><NetworkMode>03</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>7FFFFFFFFFFFFFFF</LTEBand></response>`;

/**
 * The refusal this whole todo exists to render honestly. The CODE is the bench
 * measurement; the `<error>` envelope is the dialect's own, the same one
 * `hilinkAuthRefused` already matches for `125002`.
 */
const NET_MODE_REFUSED = `<?xml version="1.0" encoding="UTF-8"?>
<error><code>112008</code><message></message></error>`;

const NET_MODE_AUTH_REFUSED = `<?xml version="1.0" encoding="UTF-8"?>
<error><code>125002</code><message></message></error>`;

// ── the catalog, read verbatim ──────────────────────────────────────────────

describe("the firmware's own network-mode catalog", () => {
	it("reads every advertised mode in the order the device listed it", () => {
		expect(parseHilinkNetModeList(NET_MODE_LIST)).toEqual([
			{ id: "00", name: "AUTO" },
			{ id: "01", name: "2G ONLY" },
			{ id: "03", name: "LTE ONLY" },
		]);
	});

	it("keeps a mode the device named with no label, and drops one with no index", () => {
		const body = `<response><NetworkModeList>
<NetworkMode><Index>02</Index></NetworkMode>
<NetworkMode><Name>ORPHAN</Name></NetworkMode>
</NetworkModeList></response>`;

		// An entry with no `<Index>` is what a Stage-B write would have to NAME,
		// so an entry we cannot name is not a capability this build may report.
		expect(parseHilinkNetModeList(body)).toEqual([{ id: "02" }]);
	});

	it("marks which mode the device says is selected", () => {
		expect(
			parseHilinkCapabilities({
				netModeList: NET_MODE_LIST,
				netMode: NET_MODE_CURRENT,
			}),
		).toEqual({
			net_mode: {
				state: "reported",
				modes: [
					{ id: "00", name: "AUTO" },
					{ id: "01", name: "2G ONLY" },
					{ id: "03", name: "LTE ONLY" },
				],
				current: "03",
			},
		});
	});

	it("reports the catalog without a current mode rather than guessing one", () => {
		for (const netMode of ["", NET_MODE_REFUSED, "<html>login</html>"]) {
			const capability = parseHilinkCapabilities({
				netModeList: NET_MODE_LIST,
				netMode,
			}).net_mode;

			expect(capability.state).toBe("reported");
			expect(capability).not.toHaveProperty("current");
		}
	});
});

// ── a refusal is reported AS a refusal ──────────────────────────────────────

describe("a firmware that refuses the question says so", () => {
	it("carries the device's own 112008 code, and fabricates no catalog", () => {
		expect(
			parseHilinkCapabilities({ netModeList: NET_MODE_REFUSED }).net_mode,
		).toEqual({ state: "unavailable", reason: "refused", code: "112008" });
	});

	it("separates a refused SESSION from a refused CAPABILITY", () => {
		// `125002` is what every endpoint answers without a valid token, so it is
		// a statement about the token — reporting it as a firmware refusal would
		// tell the operator their dongle cannot do something it may do fine.
		expect(
			parseHilinkCapabilities({ netModeList: NET_MODE_AUTH_REFUSED }).net_mode,
		).toEqual({ state: "unavailable", reason: "auth-expired" });
	});

	it("distinguishes never-answered, unreadable, and answered-with-nothing", () => {
		const reasonFor = (body: string): string => {
			const capability = parseHilinkCapabilities({
				netModeList: body,
			}).net_mode;
			return capability.state === "unavailable"
				? capability.reason
				: "reported";
		};

		expect(reasonFor("")).toBe("unreachable");
		expect(reasonFor("<html>login required</html>")).toBe("malformed");
		expect(
			reasonFor("<response><NetworkModeList></NetworkModeList></response>"),
		).toBe("not-reported");
	});

	it("ALWAYS answers, so a dongle is never silently capability-less", () => {
		for (const body of [
			"",
			NET_MODE_REFUSED,
			NET_MODE_LIST,
			"<html>x</html>",
		]) {
			expect(
				parseHilinkCapabilities({ netModeList: body }).net_mode,
			).toBeDefined();
		}
	});
});

// ── discovery rides the ONE existing request ────────────────────────────────

describe("discovery costs no extra round-trip and keeps its per-unit binding", () => {
	function hilinkDeps(
		record: { bound: string[]; urls: string[][] },
		netModeListBody: string,
	): RouterAdminProbeDeps {
		return {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () => ROUTE_OUTPUT,
			fetchViaInterface: async (ifname, urls) => {
				record.bound.push(ifname);
				if (urls[0]?.includes("SesTokInfo")) return [SESSION];
				record.urls.push([...urls]);
				return urls.map((url) => {
					if (url.endsWith("/api/device/information"))
						return HILINK_INFORMATION;
					if (url.endsWith("/api/monitoring/status")) return HILINK_STATUS;
					if (url.endsWith("/api/net/net-mode-list")) return netModeListBody;
					if (url.endsWith("/api/net/net-mode")) return NET_MODE_CURRENT;
					return "";
				});
			},
			postViaInterface: async () => {
				throw new Error("a HiLink READ cycle must never POST");
			},
		};
	}

	it("appends both reads to the read cycle's single fetch", async () => {
		const record = { bound: [] as string[], urls: [] as string[][] };
		await probeRouterCellularAdmin(
			new Map([["enx0c5b8f279a64", "12d1:14dc"]]),
			hilinkDeps(record, NET_MODE_LIST),
		);

		expect(record.urls).toHaveLength(1);
		const requested = record.urls[0] ?? [];
		expect(requested).toContain("http://192.168.8.1/api/net/net-mode-list");
		expect(requested).toContain("http://192.168.8.1/api/net/net-mode");
	});

	it("still binds each unit's discovery to its own interface", async () => {
		const record = { bound: [] as string[], urls: [] as string[][] };
		await probeRouterCellularAdmin(
			new Map([
				["enx0c5b8f279a64", "12d1:14dc"],
				["eth1", "12d1:14dc"],
			]),
			hilinkDeps(record, NET_MODE_LIST),
		);

		// The twins share one LAN address, so the binding is the ONLY thing that
		// keeps their two capability readings apart.
		expect(record.bound).toContain("enx0c5b8f279a64");
		expect(record.bound).toContain("eth1");
	});

	it("hangs the refusal off the reading the operator is shown", async () => {
		const record = { bound: [] as string[], urls: [] as string[][] };
		const readings = await probeRouterCellularAdmin(
			new Map([["enx0c5b8f279a64", "12d1:14dc"]]),
			hilinkDeps(record, NET_MODE_REFUSED),
		);

		expect(readings.get("enx0c5b8f279a64")?.capabilities).toEqual({
			net_mode: { state: "unavailable", reason: "refused", code: "112008" },
		});
	});

	it("lands in the SAME reading as controls, so no control precedes discovery", () => {
		const reading = parseHilink("http://192.168.8.1", {
			information: HILINK_INFORMATION,
			status: HILINK_STATUS,
			dataSwitch:
				'<?xml version="1.0" encoding="UTF-8"?><response><dataswitch>1</dataswitch></response>',
			connection:
				'<?xml version="1.0" encoding="UTF-8"?><response><RoamAutoConnectEnable>0</RoamAutoConnectEnable></response>',
			netModeList: NET_MODE_LIST,
			netMode: NET_MODE_CURRENT,
		});

		expect(reading.controls).toBeDefined();
		expect(reading.capabilities?.net_mode.state).toBe("reported");
	});

	it("omits the block entirely for a dialect that ran no discovery", () => {
		expect(
			parseHilink("http://192.168.8.1", {
				information: HILINK_INFORMATION,
				status: HILINK_STATUS,
			}).capabilities,
		).toBeUndefined();
	});
});

// ── The DISCOVERY path still writes nothing (Stage A's fence, retargeted) ────
//
// Stage B DID add the net-mode write and the DHCP subnet rewrite — that is the
// staged plan working as designed, not a breach of what this block guarded. What
// it guards NOW is the seam: discovery and the read probe must stay read-only,
// and every write token must live in the write modules. Stage B's own half of
// that assertion (the tokens ARE in `hilink-documents.ts`) is in
// `router-net-mode-write.test.ts`, so the pair is exact in both directions.

describe("discovery reads the network mode and never writes it", () => {
	/** Scan CODE, never prose — the module headers name what they refuse. */
	function stripComments(source: string): string {
		return source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^[ \t]*\/\/.*$/gm, "");
	}

	it("exports nothing from router-capabilities.ts that could mutate a dongle", () => {
		const exported = Object.keys(routerCapabilities).sort();
		expect(exported.length).toBeGreaterThan(0);
		for (const name of exported) {
			expect({
				name,
				mutating:
					/^(set|write|apply|send|post|configure|enable|disable|update|reset)/i.test(
						name,
					),
			}).toEqual({ name, mutating: false });
		}
	});

	it("names no net-mode or DHCP write in the discovery or admin module", () => {
		for (const name of ["router-capabilities.ts", "router-cellular-admin.ts"]) {
			const code = stripComments(
				readFileSync(join(BACKEND_SRC, "modules", "network", name), "utf8"),
			);
			// A write posts a `<NetworkMode>` request document or names the DHCP
			// settings endpoint. Both exist on this build — in
			// `router-cellular-control.ts` / `hilink-documents.ts` /
			// `router-subnet-hygiene.ts`, and in NEITHER of these two files.
			for (const re of [
				/<NetworkMode>\$\{/,
				/<request>[\s\S]*NetworkMode/,
				/dhcp\/settings/,
			]) {
				expect({ file: name, hit: re.test(code) }).toEqual({
					file: name,
					hit: false,
				});
			}
		}
	});

	it("issues only GETs, and posts nothing at all, for a HiLink read cycle", async () => {
		// A read cycle that POSTs is the defect this catches, and it stays a defect
		// after Stage B: the write path is a separate, operator-initiated call, not
		// something the 30 s poll may do on its own.
		const fetched: string[] = [];
		const deps: RouterAdminProbeDeps = {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () => ROUTE_OUTPUT,
			fetchViaInterface: async (_ifname, urls) => {
				fetched.push(...urls);
				return urls.map((url) =>
					url.includes("SesTokInfo") ? SESSION : HILINK_STATUS,
				);
			},
			postViaInterface: async () => {
				throw new Error("Stage A must never POST to a HiLink");
			},
		};

		await probeRouterCellularAdmin(
			new Map([["enx0c5b8f279a64", "12d1:14dc"]]),
			deps,
		);

		expect(fetched).toContain("http://192.168.8.1/api/net/net-mode-list");
		expect(fetched.length).toBeGreaterThan(0);
	});

	it("adds no net-mode member to `controls` — the write is its own procedure", () => {
		const reading = parseHilink("http://192.168.8.1", {
			information: HILINK_INFORMATION,
			status: HILINK_STATUS,
			dataSwitch:
				'<?xml version="1.0" encoding="UTF-8"?><response><dataswitch>1</dataswitch></response>',
			connection:
				'<?xml version="1.0" encoding="UTF-8"?><response><RoamAutoConnectEnable>0</RoamAutoConnectEnable></response>',
			netModeList: NET_MODE_LIST,
			netMode: NET_MODE_CURRENT,
		});

		expect(Object.keys(reading.controls ?? {}).sort()).toEqual([
			"mobile_data",
			"roaming_autoconnect",
		]);
	});
});
