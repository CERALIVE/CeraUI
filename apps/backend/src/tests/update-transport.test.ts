import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	classifyHttp,
	classifyTransfer,
	discoverCandidates,
	parseDebianSources,
	rankTransports,
} from "../modules/system/update-transport/core.ts";
import { runPinnedStep } from "../modules/system/update-transport/pin-rules.ts";

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

describe("NetworkManager IP interface inventory (#431)", () => {
	const row = (
		device: string,
		ipInterface: string | undefined,
		type = "gsm",
		state = "100 (connected)",
	) =>
		`GENERAL.DEVICE:${device}\n${ipInterface === undefined ? "" : `GENERAL.IP-IFACE:${ipInterface}\n`}GENERAL.TYPE:${type}\nGENERAL.STATE:${state}\nGENERAL.METERED:no`;
	const ethernet = {
		ifname: "eth0",
		kind: "ethernet",
		metered: false,
	} as const;
	const cellular = {
		ifname: "wwan0",
		kind: "cellular",
		metered: true,
	} as const;

	it.each([
		["cdc-wdm0", "wwan0", "gsm", cellular],
		["ttyUSB2", "ppp0", "gsm", { ...cellular, ifname: "ppp0" }],
		["eth0", "eth0", "ethernet", ethernet],
		["eth0", undefined, "ethernet", ethernet],
		["eth0", "", "ethernet", ethernet],
		["eth0", "--", "ethernet", ethernet],
		["eth0", "  --  ", "ethernet", ethernet],
		["eth0", "   ", "ethernet", ethernet],
		["wwan0", undefined, "gsm", cellular],
		["cdc-wdm0", " wwan0 ", "gsm", cellular],
	] as const)(
		"%s with IP-IFACE=%s resolves the connected owner",
		(device, ipInterface, type, expected) => {
			expect(
				discoverCandidates(
					[expected.ifname],
					row(device, ipInterface, type),
					[],
					[],
				),
			).toEqual([expected]);
		},
	);

	it.each([false, true])(
		"the control-port owner overrides a self-named shadow, reverse=%s",
		(reverse) => {
			const rows = [
				row("cdc-wdm0", "wwan0"),
				row("wwan0", "wwan0", "ethernet"),
			];
			expect(
				discoverCandidates(
					["wwan0"],
					(reverse ? rows.reverse() : rows).join("\n\n"),
					[],
					[],
				),
			).toEqual([cellular]);
		},
	);

	it.each([false, true])(
		"a disconnected owner cannot borrow its connected shadow, reverse=%s",
		(reverse) => {
			const rows = [
				row("cdc-wdm0", "wwan0", "gsm", "30 (disconnected)"),
				row("wwan0", "wwan0", "ethernet"),
			];
			expect(
				discoverCandidates(
					["wwan0"],
					(reverse ? rows.reverse() : rows).join("\n\n"),
					[],
					[],
				),
			).toEqual([]);
		},
	);

	it.each([false, true])(
		"two distinct owners drop only their contested key, reverse=%s",
		(reverse) => {
			const rows = [
				row("cdc-wdm0", "wwan0"),
				row("cdc-wdm1", "wwan0"),
				row("wwan0", "wwan0", "ethernet"),
				row("eth0", "eth0", "ethernet"),
			];
			expect(
				discoverCandidates(
					["wwan0", "eth0"],
					(reverse ? rows.reverse() : rows).join("\n\n"),
					[],
					[],
				),
			).toEqual([ethernet]);
		},
	);

	it.each([
		`${row("cdc-wdm0", "wwan0")}\n\n${row("cdc-wdm0", "wwan1")}`,
		`${row("cdc-wdm0", "wwan0")}\nGENERAL.IP-IFACE:wwan1`,
		`${row("cdc-wdm0", "wwan0")}\nGENERAL.METERED:yes`,
		`${row("cdc-wdm0", "wwan0")}\nGENERAL.UNKNOWN:value`,
		`${row("cdc-wdm0", "wwan0")}\nbroken`,
		row("cdc-wdm0", "wwan0").replace("GENERAL.TYPE:gsm\n", ""),
		row("cdc-wdm0", "wwan0").replace("GENERAL.STATE:100 (connected)\n", ""),
		row("cdc-wdm0", "wwan0").replace("GENERAL.DEVICE:cdc-wdm0\n", ""),
		"wwan0:gsm:connected:yes\nwwan0:gsm:connected:yes",
	])("structurally ambiguous inventory fails closed: %s", (invalid) => {
		expect(
			discoverCandidates(
				["wwan0", "eth0"],
				`${row("eth0", undefined, "ethernet")}\n\n${invalid}`,
				[],
				[],
			),
		).toEqual([]);
	});

	it("replays the constructed twin modem fixture as two cellular candidates", () => {
		const fixture =
			readFileSync(
				new URL(
					"./fixtures/real-device/rock-nm-1.52.1-twin-modem-general.txt",
					import.meta.url,
				),
				"utf8",
			).split("##### twin-modem-general\n")[1] ?? "";
		expect(discoverCandidates(["wwan0", "wwan1"], fixture, [], [])).toEqual([
			cellular,
			{ ...cellular, ifname: "wwan1" },
		]);
	});

	it("keeps legacy compact inventory unchanged", () => {
		expect(
			discoverCandidates(
				["wwan0", "eth0"],
				"wwan0:gsm:connected:yes\neth0:ethernet:connected:no",
				[],
				[],
			),
		).toEqual([cellular, ethernet]);
	});

	it("pins a gatewayless PPP default route and removes its inherited metric", async () => {
		const calls: string[][] = [];
		const result = await runPinnedStep({
			job: "apt",
			uid: 42042,
			transport: {
				candidate: { ifname: "ppp0", kind: "cellular", metered: true },
				family: 4,
				hosts: [],
				reason: "fixture",
				healthy: true,
				latencyMs: 1,
			},
			runner: async (_bin, args) => {
				calls.push([...args]);
				return args.join(" ") === "route show default"
					? "default dev ppp0 proto static scope link metric 700"
					: "";
			},
			step: async () => "transferred",
		});
		expect(result).toBe("transferred");
		expect(calls).toContainEqual([
			"route",
			"add",
			"default",
			"dev",
			"ppp0",
			"proto",
			"static",
			"scope",
			"link",
			"table",
			"100000",
			"metric",
			"0",
		]);
	});
});
