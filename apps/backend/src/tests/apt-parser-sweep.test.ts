import { expect, it } from "bun:test";
import { discoverAptAllPackages } from "../modules/system/apt-all-packages.ts";
import {
	parseAptArchivePath,
	parseAptSpaceProbe,
} from "../modules/system/apt-space-parser.ts";
import {
	buildDiscoveredPackages,
	deriveAptProgress,
	parseAptPackageList,
	parseAptUpgradeSummary,
	parseHeldBackPackages,
	parseKeptBackPackageNames,
	parseUpgradeDownloadSize,
	parseUpgradePackageCount,
} from "../modules/system/software-updates.ts";
import { opiAptSection, opiNginxPairs } from "./helpers/apt-opi-capture.ts";

const simulation = opiAptSection("SIM");
const heading = "The following packages will be upgraded:\n";

it.each(["\n", "\r\n"])(
	"reads captured package names with line ending %j",
	(ending) => {
		// Given
		const text = simulation.replaceAll("\n", ending);
		// When/Then
		expect(parseAptPackageList(text, heading)).toEqual({
			ok: true,
			value: "nginx nginx-common nginx-light",
		});
		expect(parseUpgradePackageCount(text)).toEqual({ ok: true, value: 3 });
	},
);

it("does not invent a legacy download size from a simulation-only capture", () => {
	// Given/When/Then
	expect(parseUpgradeDownloadSize(simulation).ok).toBe(false);
	expect(parseAptUpgradeSummary(simulation).ok).toBe(false);
});

it.each([
	"Need to get 321 kB of archives.",
	"Need to get 0 B/321 kB of archives.",
])("reads applicable captured legacy fields with %s", (size) => {
	// Given
	const text = `${simulation}${size}\n`;
	// When/Then
	expect(parseAptUpgradeSummary(text)).toEqual({
		ok: true,
		value: {
			upgradeCount: 3,
			downloadSize: size.includes("0 B/") ? "0 B" : "321 kB",
			ceralivePackages: false,
			packages: ["nginx", "nginx-common", "nginx-light"],
		},
	});
});

it.each(["", "The following packages will be upgraded:", "unrelated output\n"])(
	"does not invent names from a missing/truncated heading %j",
	(text) => {
		// Given/When/Then
		expect(parseAptPackageList(text, heading)).toEqual({
			ok: true,
			value: undefined,
		});
	},
);

it("reads the exact captured holds as argv-safe names without treating them as kept-back prose", () => {
	// Given/When
	const actual = parseHeldBackPackages(opiAptSection("HOLDS"));
	// Then
	expect(actual).toEqual([
		"armbian-firmware-full",
		"librockchip-mpp1",
		"libv4l-0",
		"linux-image-7.2.0-ceralive-rk3588",
		"linux-u-boot-orangepi5-plus-edge",
		"rauc",
		"rauc-service",
		"rockchip-multimedia-config",
	]);
	expect(parseKeptBackPackageNames(opiAptSection("HOLDS"))).toEqual([]);
});

it.each(["\n", "\r\n"])(
	"retains kept-back precedence and drops only malformed informational names with %j",
	(ending) => {
		// Given
		const text =
			`The following packages have been kept back:\n  cerastream bad_name\n  g++\n0 upgraded, 0 newly installed, 0 to remove and 2 not upgraded.\n`.replaceAll(
				"\n",
				ending,
			);
		// When
		const names = parseKeptBackPackageNames(text);
		// Then
		expect(names).toEqual(["cerastream", "g++"]);
		expect(buildDiscoveredPackages(["cerastream"], names)[0]).toMatchObject({
			name: "cerastream",
			actionable: false,
			kept_back: true,
		});
		expect(() => parseHeldBackPackages("cerastream bad_name")).toThrow();
	},
);

it("keeps simulation actions out of live download/unpack/configure progress", () => {
	// Given/When
	const actual = deriveAptProgress(
		{ total: 0, downloading: 0, unpacking: 0, setting_up: 0 },
		simulation,
	);
	// Then
	expect(actual).toEqual({
		total: 3,
		downloading: 0,
		unpacking: 0,
		setting_up: 0,
	});
});

it.each([
	[
		"missing inventory",
		"Package files:\nPinned packages:\n",
		opiAptSection("PKG-nginx"),
	],
	[
		"no candidate",
		opiAptSection("POLICY"),
		opiAptSection("PKG-nginx").replace(
			"Candidate: 1.26.3-3+deb13u10",
			"Candidate: (none)",
		),
	],
	[
		"missing version table",
		opiAptSection("POLICY"),
		"nginx:\n Candidate: 1.26.3-3+deb13u10\n",
	],
	[
		"conflicting inventory",
		opiAptSection("POLICY").replace(
			"Pinned packages:",
			" 500 https://deb.debian.org/debian-security trixie-security/main arm64 Packages\n     release o=Other,n=trixie-security,l=Other\n     origin deb.debian.org\nPinned packages:",
		),
		opiAptSection("PKG-nginx"),
	],
	[
		"missing release metadata",
		opiAptSection("POLICY").replace(
			"release v=13,o=Debian",
			"unavailable v=13,o=Debian",
		),
		opiAptSection("PKG-nginx"),
	],
])(
	"keeps captured candidate informational for %s",
	async (_label, sources, policy) => {
		// Given/When
		const result = await discoverAptAllPackages(
			"Inst nginx (1.26.3-3+deb13u10 Debian-Security:13/stable-security [arm64])\n",
			"",
			async () => policy,
			sources,
		);
		// Then
		expect(result.actionable).toEqual([]);
		expect(result.packages).toEqual([
			{ ...opiNginxPairs[0], layer: "platform", actionable: false },
		]);
	},
);

it("accepts repeated identical source metadata without widening origin policy", async () => {
	// Given
	const sources = opiAptSection("POLICY");
	const entry =
		" 500 https://deb.debian.org/debian-security trixie-security/main arm64 Packages\n     release v=13,o=Debian,a=stable-security,n=trixie-security,l=Debian-Security,c=main,b=arm64\n     origin deb.debian.org\n";
	// When
	const result = await discoverAptAllPackages(
		simulation,
		"",
		async (name) => opiAptSection(`PKG-${name}`),
		sources.replace("Pinned packages:", `${entry}Pinned packages:`),
	);
	// Then
	expect(result.actionable).toEqual([...opiNginxPairs]);
});

it("decodes apt-config shell quoting as data and handles CRLF print-uris", () => {
	// Given/When/Then
	expect(
		parseAptArchivePath("ARCHIVES='/cache/apt'\\''s archives/';\r\n"),
	).toBe("/cache/apt's archives/");
	expect<{ download_bytes: bigint; install_delta_bytes: bigint }>(
		parseAptSpaceProbe(
			"After this operation, 1.5 kB of additional disk space will be used.\r\n'https://example.invalid/pkg.deb' pkg.deb 123 SHA256:abc\r\n",
		),
	).toEqual({ download_bytes: 123n, install_delta_bytes: 1500n });
});

it("refuses duplicate disk deltas and does not treat the simulation as a print-uris probe", () => {
	// Given
	const delta =
		"After this operation, 1 kB of additional disk space will be used.\n";
	// When/Then
	expect(() =>
		parseAptSpaceProbe(
			`${delta}${delta}'https://example.invalid/pkg.deb' pkg.deb 123 SHA256:abc\n`,
		),
	).toThrow("probe_delta_malformed");
	expect(() => parseAptSpaceProbe(simulation)).toThrow("probe_no_uri_rows");
});
