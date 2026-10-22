/// <reference types="bun" />

import { expect, it } from "bun:test";
import { file } from "bun";
import {
	AptAllRefusalError,
	assertPinnedInstallSimulation,
	parseAptSimulation,
} from "../modules/system/apt-all-packages.ts";

const captured = await file(
	new URL("./fixtures/apt-opi-upgrade-20261014.stdout", import.meta.url),
).text();
const pairs = [
	{ name: "curl", version: "8.14.1-2+deb13u7" },
	{ name: "libcurl4t64", version: "8.14.1-2+deb13u7" },
	{ name: "libcurl3t64-gnutls", version: "8.14.1-2+deb13u7" },
];
const row = "Inst curl [1] (2 Debian-Security:13/stable-security [arm64])";

it("parses exactly the three captured OPI package/version pairs", () => {
	// Given/When
	const actual = parseAptSimulation(captured);
	// Then
	expect(actual).toEqual(pairs);
});

it("accepts the captured annotation at the pinned install recheck", () => {
	// Given/When/Then
	expect(() => assertPinnedInstallSimulation(captured, pairs)).not.toThrow();
});

it.each([
	"",
	"libcurl4t64",
	"libcurl4t64 g++ python3.13 libc6:arm64",
	"libcurl4t64 ",
	"libcurl4t64:arm64 libc6:arm64 ",
])(
	"ignores valid annotation names %j instead of adding install authority",
	(annotation) => {
		// Given
		const text = `${row} [${annotation}]\n`;
		// When
		const actual = parseAptSimulation(text);
		// Then
		expect(actual).toEqual([{ name: "curl", version: "2" }]);
		expect(() => assertPinnedInstallSimulation(text, actual)).not.toThrow();
	},
);

it.each([
	" [",
	" [libcurl4t64",
	" [[libcurl4t64]]",
	" [libcurl4t64] []",
	" [x] [y]",
	" [] trailing",
	" [libcurl4t64] trailing",
	" [--allow-unauthenticated]",
	" [-o]",
	" [/etc/fixture]",
	" [libcurl4t64;reboot]",
	" [lib_curl]",
	" [libcurl4t64\tlibc6]",
	" [libcurl4t64  libc6]",
	" [ libcurl4t64]",
	"\t[]",
	"  []",
	" []\t",
])("refuses malformed annotation %j in discovery and recheck", (suffix) => {
	// Given
	const line = `${row}${suffix}`;
	// When/Then
	for (const parse of [
		() => parseAptSimulation(`${line}\n`),
		() =>
			assertPinnedInstallSimulation(`${line}\n`, [
				{ name: "curl", version: "2" },
			]),
	]) {
		expect(parse).toThrow(AptAllRefusalError);
		expect(parse).toThrow(
			expect.objectContaining({
				reason: "discovery_failed",
				step: "parse-simulation",
				detail: expect.stringContaining(line.replace(/\s+/g, " ").trim()),
			}),
		);
	}
});

it.each([`${row} []\n${row} []`, `${row}\n${row} [libcurl4t64]`])(
	"refuses duplicate Inst names with annotations: %j",
	(text) => {
		// Given/When/Then
		expect(() => parseAptSimulation(text)).toThrow(
			expect.objectContaining({
				reason: "discovery_failed",
				step: "parse-simulation",
			}),
		);
	},
);

it.each([`Remv libc6 [1]\n${row} []`, `${row} []\nRemv libc6 [1]`])(
	"keeps removals forbidden anywhere: %j",
	(text) => {
		// Given/When/Then
		expect(() => parseAptSimulation(text)).toThrow(
			expect.objectContaining({
				reason: "removals_required",
				step: "parse-simulation",
			}),
		);
	},
);

it.each([
	"Inst curl [bad] (2 Debian [arm64]) []",
	"Inst curl (bad Debian [arm64]) []",
	"Inst --curl (2 Debian [arm64]) []",
	"Conf curl (2 Debian [arm64]) []",
])("keeps name/version and summary refusals for %j", (text) => {
	// Given/When/Then
	expect(() => parseAptSimulation(text)).toThrow("discovery_failed");
});

it("retains the zero-upgrade summary rule", () => {
	// Given/When
	const actual = parseAptSimulation(
		"0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n",
	);
	// Then
	expect(actual).toEqual([]);
});
