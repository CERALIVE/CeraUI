import { describe, expect, it } from "bun:test";
import {
	classifyHttp,
	classifyTransfer,
	discoverCandidates,
	parseDebianSources,
	rankTransports,
} from "../modules/system/update-transport/core.ts";

const deviceSources = `Types: deb
URIs: https://deb.debian.org/debian
Suites: trixie
Components: main non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: https://deb.debian.org/debian-security
Suites: trixie-security
Components: main non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: https://deb.debian.org/debian
Suites: trixie-updates
Components: main non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg`;

describe("update source derivation (runtime postinst debian.sources)", () => {
	it("derives all three URI/suite pairs and carries their own keyring", () => {
		expect(parseDebianSources(deviceSources)).toEqual([
			{
				url: "https://deb.debian.org/debian/dists/trixie/InRelease",
				keyring: "/usr/share/keyrings/debian-archive-keyring.gpg",
			},
			{
				url: "https://deb.debian.org/debian-security/dists/trixie-security/InRelease",
				keyring: "/usr/share/keyrings/debian-archive-keyring.gpg",
			},
			{
				url: "https://deb.debian.org/debian/dists/trixie-updates/InRelease",
				keyring: "/usr/share/keyrings/debian-archive-keyring.gpg",
			},
		]);
	});
	it("supports legacy signed-by and marks an unsigned source unverifiable", () => {
		expect(
			parseDebianSources(
				"deb [signed-by=/tmp/key.gpg] https://deb.debian.org/debian trixie main\ndeb https://deb.debian.org/debian trixie main",
			),
		).toEqual([
			{
				url: "https://deb.debian.org/debian/dists/trixie/InRelease",
				keyring: "/tmp/key.gpg",
			},
			{
				url: "https://deb.debian.org/debian/dists/trixie/InRelease",
				keyring: "",
			},
		]);
		expect(
			parseDebianSources(
				`${deviceSources}\n\nEnabled: no\nURIs: https://deb.debian.org/debian\nSuites: old\nSigned-By: /tmp/key.gpg`,
			),
		).toHaveLength(3);
	});
});

describe("per-uplink classification", () => {
	it.each([
		[204, "", "clear"],
		[302, "", "captive-http"],
		[204, "portal", "captive-http"],
		[200, "", "captive-http"],
		[404, "", "captive-http"],
	] as const)("HTTP %i with body %s is %s", (code, body, expected) => {
		expect(classifyHttp(code, body)).toBe(expected);
	});
	it.each([
		["tls", true, "captive-tls"],
		["tls", false, "tls-error"],
		["timeout", false, "blocked"],
		["refused", false, "no-route"],
		["dns", false, "dns-failed"],
		["gpgv", false, "tampered"],
	] as const)("%s after portal=%s is %s", (failure, captive, expected) => {
		expect(classifyTransfer(failure, captive)).toBe(expected);
	});
	it("a rejected fleet certificate is not a transport failure", () => {
		expect(classifyTransfer("credentials", false)).toBe("credentials-invalid");
	});
	it("discovers a router dongle regardless of an eth name, and metered guesses are cellular", () => {
		const result = discoverCandidates(
			["eth0", "eth1", "wlan0"],
			"eth0:ethernet:connected:GENERAL.METERED:no\neth1:ethernet:connected:GENERAL.METERED:no\nwlan0:wifi:connected:GENERAL.METERED:guess-yes",
			["eth1"],
			["eth1"],
		);
		expect(result).toEqual([
			{ ifname: "eth0", kind: "ethernet", metered: false },
			{ ifname: "eth1", kind: "cellular", metered: true },
			{ ifname: "wlan0", kind: "cellular", metered: true },
		]);
	});
});

describe("ranking", () => {
	it("prefers unmetered, then physical kind; all-hosts-pass then latency within one class", () => {
		const candidates = [
			{ ifname: "cell0", kind: "cellular", metered: true },
			{ ifname: "wifi0", kind: "wifi", metered: false },
			{ ifname: "eth0", kind: "ethernet", metered: false },
		] as const;
		const samples = candidates.flatMap((candidate) =>
			([4, 6] as const).map((family) => ({
				candidate,
				family,
				hosts: [
					{
						host: "apt.ceralive.tv",
						state: family === 4 ? ("clear" as const) : ("blocked" as const),
						latencyMs: candidate.ifname === "eth0" ? 50 : 1,
					},
				],
			})),
		);
		const selection = rankTransports(samples);
		expect(selection.status).toBe("selected");
		expect(
			selection.ranked.map((row) => `${row.candidate.ifname}/${row.family}`),
		).toEqual(["eth0/4", "wifi0/4", "cell0/4", "eth0/6", "wifi0/6", "cell0/6"]);
		expect(selection.ranked[0]?.reason).toContain("unmetered");
	});
	it("returns a typed none refusal and never persists a family", () => {
		expect(rankTransports([])).toMatchObject({
			status: "none",
			reason: "no-healthy-transport",
			ranked: [],
		});
	});
});
