import { describe, expect, test } from "bun:test";

import {
	decideConnectivityClaim,
	deviceBoundProbeExclusionReason,
	eligibleProbeCandidates,
	NO_INTERNET_MSGS,
	parseDefaultRouteInterface,
	probeExclusionReason,
} from "../modules/network/connectivity-candidates.ts";
import { formatUrlHost, httpGet } from "../modules/network/internet.ts";
import {
	NETIF_ERR_DUPIPV4,
	NETIF_ERR_HOTSPOT,
	type NetworkInterface,
} from "../modules/network/network-interfaces.ts";

function iface(over: Partial<NetworkInterface> = {}): NetworkInterface {
	return {
		ip: "192.168.1.10",
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
		...over,
	};
}

/**
 * The exact roster the board reported over the `netif` wire while it was firing
 * the false alarm: a duplicate-MAC HiLink pair both leasing 192.168.8.100 (both
 * dup-IP suppressed), plus a working ZTE dongle and the LAN port.
 */
const BOARD_NETIF: Record<string, NetworkInterface> = {
	eth0: iface({ ip: "192.168.78.132" }),
	enx344b50000000: iface({ ip: "192.168.0.169" }),
	enx0c5b8f279a64: iface({
		ip: "192.168.8.100",
		enabled: false,
		error: NETIF_ERR_DUPIPV4,
	}),
	eth1: iface({
		ip: "192.168.8.100",
		enabled: false,
		error: NETIF_ERR_DUPIPV4,
	}),
};

describe("probeExclusionReason", () => {
	test("a dup-IPv4 interface is never a probe source", () => {
		expect(
			probeExclusionReason(iface({ enabled: false, error: NETIF_ERR_DUPIPV4 })),
		).toBe("duplicate IPv4 addr");
	});

	test("a broadcasting hotspot radio is never a probe source", () => {
		expect(
			probeExclusionReason(iface({ enabled: false, error: NETIF_ERR_HOTSPOT })),
		).toBe("WiFi hotspot");
	});

	test("an addressless interface is excluded — there is no source to bind", () => {
		expect(probeExclusionReason(iface({ ip: undefined }))).toBe("no address");
	});

	test("a missing interface is excluded", () => {
		expect(probeExclusionReason(undefined)).toBe("interface not present");
	});

	test("a healthy addressed interface is eligible", () => {
		expect(probeExclusionReason(iface())).toBeUndefined();
	});

	// `enabled` is overloaded: the error flags set it, but so does the operator
	// toggling a link out of the BOND. "Do not send bonded video over this link"
	// is not "this link may not be used to check for Internet", so an
	// operator-disabled-but-healthy interface stays probeable.
	test("an operator-disabled interface with no error stays probeable", () => {
		expect(probeExclusionReason(iface({ enabled: false }))).toBeUndefined();
	});
});

// A duplicate IPv4 address disqualifies an interface as a SOURCE, and does not
// disqualify the DEVICE — the two questions have opposite correct answers, in
// exactly the way todo 11 split bond membership from source-IP eligibility.
describe("deviceBoundProbeExclusionReason", () => {
	test("a dup-IPv4 interface IS probeable when the probe binds the device", () => {
		expect(
			deviceBoundProbeExclusionReason(
				iface({ enabled: false, error: NETIF_ERR_DUPIPV4 }),
			),
		).toBeUndefined();
	});

	test("a broadcasting hotspot radio is still excluded", () => {
		expect(
			deviceBoundProbeExclusionReason(
				iface({ enabled: false, error: NETIF_ERR_HOTSPOT }),
			),
		).toBe("WiFi hotspot");
	});

	test("a hotspot radio that ALSO has a dup address is still excluded", () => {
		expect(
			deviceBoundProbeExclusionReason(
				iface({ error: NETIF_ERR_HOTSPOT | NETIF_ERR_DUPIPV4 }),
			),
		).toBe("WiFi hotspot");
	});

	test("an addressless interface is excluded — it has no lease to egress on", () => {
		expect(deviceBoundProbeExclusionReason(iface({ ip: undefined }))).toBe(
			"no address",
		);
	});

	test("a missing interface is excluded", () => {
		expect(deviceBoundProbeExclusionReason(undefined)).toBe(
			"interface not present",
		);
	});
});

describe("eligibleProbeCandidates", () => {
	test("the board roster probes all four, binding the twins BY DEVICE", () => {
		expect(eligibleProbeCandidates(BOARD_NETIF)).toEqual([
			{
				name: "eth0",
				ip: "192.168.78.132",
				binding: { kind: "source-ip", ip: "192.168.78.132" },
			},
			{
				name: "enx344b50000000",
				ip: "192.168.0.169",
				binding: { kind: "source-ip", ip: "192.168.0.169" },
			},
			{
				name: "enx0c5b8f279a64",
				ip: "192.168.8.100",
				binding: { kind: "device", ifname: "enx0c5b8f279a64" },
			},
			{
				name: "eth1",
				ip: "192.168.8.100",
				binding: { kind: "device", ifname: "eth1" },
			},
		]);
	});

	// The twins are now probeable, and they are STILL refused as a generic
	// source IP — the split, asserted from both sides on the same roster.
	test("the twins stay refused as a source address", () => {
		for (const name of ["enx0c5b8f279a64", "eth1"]) {
			expect(probeExclusionReason(BOARD_NETIF[name])).toBe(
				"duplicate IPv4 addr",
			);
		}
	});

	test("no two candidates share a device binding", () => {
		const bound = eligibleProbeCandidates(BOARD_NETIF)
			.map((c) => (c.binding.kind === "device" ? c.binding.ifname : undefined))
			.filter((n): n is string => n !== undefined);
		expect(bound).toEqual(["enx0c5b8f279a64", "eth1"]);
		expect(new Set(bound).size).toBe(bound.length);
	});

	test("a roster of only hotspot/addressless interfaces yields none", () => {
		expect(
			eligibleProbeCandidates({
				wlan0: iface({ enabled: false, error: NETIF_ERR_HOTSPOT }),
				usb0: iface({ ip: undefined }),
			}),
		).toEqual([]);
	});

	test("an empty roster yields none", () => {
		expect(eligibleProbeCandidates({})).toEqual([]);
	});
});

describe("parseDefaultRouteInterface", () => {
	// Verbatim `ip route show default` from the board. The dongle's DHCP lease
	// installs a metric-less (metric 0) default that outranks eth0's metric 101,
	// which is why the FIRST line is the active one.
	const BOARD_ROUTES = [
		"default via 192.168.8.1 dev enx0c5b8f279a64 ",
		"default via 192.168.78.1 dev eth0 proto dhcp src 192.168.78.132 metric 101 ",
		"default via 192.168.0.1 dev enx344b50000000 proto dhcp src 192.168.0.169 metric 103 ",
		"default via 192.168.8.1 dev enx0c5b8f279a64 proto dhcp src 192.168.8.100 metric 104 ",
		"default via 192.168.8.1 dev eth1 proto dhcp src 192.168.8.100 metric 105 ",
	].join("\n");

	test("picks the first (lowest-metric) default route's interface", () => {
		expect(parseDefaultRouteInterface(BOARD_ROUTES)).toBe("enx0c5b8f279a64");
	});

	test("reads a device-only default route", () => {
		expect(parseDefaultRouteInterface("default dev wwan0 scope link")).toBe(
			"wwan0",
		);
	});

	test("empty output has no default interface", () => {
		expect(parseDefaultRouteInterface("")).toBeUndefined();
		expect(parseDefaultRouteInterface("\n  \n")).toBeUndefined();
	});

	test("a default route with no dev clause is not guessed at", () => {
		expect(
			parseDefaultRouteInterface("default via 192.168.8.1"),
		).toBeUndefined();
	});

	test("non-default lines are ignored", () => {
		expect(
			parseDefaultRouteInterface(
				"192.168.8.0/24 dev eth1 proto kernel scope link\n" +
					"default via 10.0.0.1 dev usb0",
			),
		).toBe("usb0");
	});
});

describe("decideConnectivityClaim", () => {
	test("the board's state suppresses the claim — the default route is excluded", () => {
		const claim = decideConnectivityClaim({
			candidateCount: 2,
			defaultIfname: "enx0c5b8f279a64",
			defaultExclusionReason: "duplicate IPv4 addr",
		});
		expect(claim).toEqual({
			kind: "suppressed",
			ifname: "enx0c5b8f279a64",
			reason: "duplicate IPv4 addr",
		});
	});

	test("an ELIGIBLE default route that failed still blames the default connection", () => {
		const claim = decideConnectivityClaim({
			candidateCount: 2,
			defaultIfname: "eth0",
			defaultExclusionReason: undefined,
		});
		expect(claim).toEqual({
			kind: "default-failed",
			message: NO_INTERNET_MSGS.defaultFailed,
		});
	});

	test("an unreadable default route is not mistaken for an excluded one", () => {
		const claim = decideConnectivityClaim({
			candidateCount: 2,
			defaultIfname: undefined,
			defaultExclusionReason: undefined,
		});
		expect(claim.kind).toBe("default-failed");
	});

	test("no eligible interface is its own state, not a default-connection failure", () => {
		const claim = decideConnectivityClaim({
			candidateCount: 0,
			defaultIfname: "eth0",
			defaultExclusionReason: undefined,
		});
		expect(claim).toEqual({
			kind: "no-eligible",
			message: NO_INTERNET_MSGS.noEligible,
		});
	});

	test("no eligible interface outranks an excluded default route", () => {
		const claim = decideConnectivityClaim({
			candidateCount: 0,
			defaultIfname: "enx0c5b8f279a64",
			defaultExclusionReason: "duplicate IPv4 addr",
		});
		expect(claim.kind).toBe("no-eligible");
	});

	test("the claims are distinct sentences", () => {
		const messages = new Set(Object.values(NO_INTERNET_MSGS));
		expect(messages.size).toBe(Object.keys(NO_INTERNET_MSGS).length);
	});

	// A probe steered by SOURCE ADDRESS only selects a route where the kernel
	// supports policy routing; this board's does not (`ip rule show` answers
	// "Operation not supported", and a source-bound request to a working eth0
	// times out while a device-bound one returns 204). So there is deliberately
	// no message for "every candidate failed" — the suppressed claim has no
	// escalation, or the fix would swap one false alarm for another.
	test("there is no message for an all-candidates-failed claim", () => {
		expect(Object.keys(NO_INTERNET_MSGS).sort()).toEqual([
			"defaultFailed",
			"noEligible",
		]);
	});
});

describe("a bound probe egresses the address it was given", () => {
	// The regression this locks: `httpGet` accepted `localAddress`, threaded it
	// through `HttpGetOptions`, and dropped it in its destructure — so every
	// "per-interface" probe silently used the current default route and the
	// fallback loop could never elect a working interface. Asserted against a
	// real socket, because the whole defect was a parameter that type-checked.
	test("the server sees the requested source address", async () => {
		let observedRemoteAddress: string | undefined;

		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(_req, srv) {
				observedRemoteAddress = srv.requestIP(_req)?.address;
				return new Response("", { status: 204 });
			},
		});

		try {
			const res = await httpGet({
				host: "127.0.0.1",
				port: server.port,
				path: "/generate_204",
				timeout: 4000,
				localAddress: "127.0.0.1",
			});

			expect(res.code).toBe(204);
			expect(res.body).toBe("");
			expect(observedRemoteAddress).toBe("127.0.0.1");
		} finally {
			server.stop(true);
		}
	});
});

describe("formatUrlHost", () => {
	test("an IPv4 literal is untouched", () => {
		expect(formatUrlHost("142.251.133.99")).toBe("142.251.133.99");
	});

	test("an IPv6 literal is bracketed so the URL parses", () => {
		expect(formatUrlHost("2a00:1450:4001:80f::2003")).toBe(
			"[2a00:1450:4001:80f::2003]",
		);
	});

	test("an already-bracketed IPv6 literal is not double-bracketed", () => {
		expect(formatUrlHost("[::1]")).toBe("[::1]");
	});
});
