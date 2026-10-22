/// <reference types="bun" />

import { expect, it } from "bun:test";
import {
	assertPinnedInstallSimulation,
	parseAptSimulation,
} from "../modules/system/apt-all-packages.ts";

const pair = { name: "libc6:arm64", version: "2:2.41+ds1-0~deb13u4" };
const candidate = `(${pair.version} Debian:13/stable [arm64])`;
const install = `Inst ${pair.name} [2:2.40-1] ${candidate}`;

it.each([
	`Inst ${pair.name} ${candidate}`,
	install,
	`${install} []`,
	`${install} [nginx:arm64 ]`,
	`${install} [nginx:arm64 nginx-light:all ]`,
	`${install} [nginx:arm64 nginx-light:all]`,
	`${install} [nginx:arm64 on libc6:arm64]`,
	`${install} [nginx:arm64 on libc6:arm64] [nginx-light:all on libc6:arm64] []`,
	`${install} [nginx:arm64 on libc6:arm64] [nginx-light:all ]`,
	`Inst ${pair.name} (${pair.version} Debian:13/stable, Debian-Security:13/stable-security [arm64])`,
	`Inst ${pair.name} (${pair.version} Example Archive:13/stable [arm64])`,
	`Inst ${pair.name} (${pair.version} localhost [arm64])`,
	`Inst ${pair.name} (${pair.version}  [arm64])`,
	`Inst ${pair.name} (${pair.version} Example (internal):13/stable, Dépôt:stable [arm64])`,
	`Inst ${pair.name} (${pair.version} )`,
])("pins only the Inst pair for apt row %j", (line) => {
	// Given/When
	const actual = parseAptSimulation(`${line}\n`);
	// Then
	expect(actual).toEqual([pair]);
	expect(() =>
		assertPinnedInstallSimulation(`${line}\n`, [pair]),
	).not.toThrow();
});

it.each([
	"Conf nginx",
	"Conf nginx []",
	"Conf nginx [libc6:arm64 ]",
	"Conf nginx (1 Debian:13/stable [arm64])",
	"Conf nginx (1 Debian:13/stable [arm64]) [libc6:arm64 ]",
])("validates configure context without adding authority for %j", (line) => {
	// Given/When
	const actual = parseAptSimulation(`${install}\n${line}\n`);
	// Then
	expect(actual).toEqual([pair]);
});

it.each([
	`${install} [nginx:arm64 on --bad]`,
	`${install} [nginx on libc6:arm64]`,
	`${install} [nginx:arm64 on libc6]`,
	`${install} [nginx:arm64 on libc6:arm64 ]`,
	`${install} [nginx:arm64 ] [nginx:arm64 on libc6:arm64]`,
	`${install} [nginx:arm64 on libc6:arm64`,
	`${install} [nginx:arm64  ]`,
	`${install} [nginx:arm64] []`,
	`${install} (1 Debian [arm64])`,
	"Inst libc6 [1]",
	"Inst libc6",
	"Inst\tlibc6 (1 Debian [arm64])",
	"Conf libc6 [1] (2 Debian [arm64])",
	"Conf libc6 (2 Debian [arm64]) junk",
	"Conf libc6:arm64 broken Depends:nginx:arm64",
	"Conf --bad",
	"Bork libc6 (2 Debian [arm64])",
	"Bork libc6",
	"UnknownVerb libc6 (2 Debian [arm64])",
	"Unpack libc6 [nginx:arm64 ]",
	"Instl libc6",
	"Setup libc6:armhf",
])(
	"refuses malformed or unpinnable row %j even beside a valid install",
	(line) => {
		// Given
		const text = `Inst context (1 Debian [arm64])\n${line}\n`;
		// When/Then
		expect(() => parseAptSimulation(text)).toThrow("discovery_failed");
		expect(() =>
			assertPinnedInstallSimulation(text, [{ name: "context", version: "1" }]),
		).toThrow("discovery_failed");
	},
);

it.each(["Remv", "Purg"])(
	"refuses every %s shape before and after installs",
	(verb) => {
		// Given
		for (const suffix of ["", " [1]", " [1] []", " [1] [nginx:arm64 ]"]) {
			for (const text of [
				`${verb} nginx${suffix}\n${install}`,
				`${install}\n${verb} nginx${suffix}`,
			]) {
				// When/Then
				expect(() => parseAptSimulation(text)).toThrow("removals_required");
				expect(() => assertPinnedInstallSimulation(text, [pair])).toThrow(
					"removals_required",
				);
			}
		}
	},
);

it("refuses duplicate install names even when versions or annotations differ", () => {
	// Given
	const text = `${install}\nInst ${pair.name} (9 Debian [arm64]) []\n`;
	// When/Then
	expect(() => parseAptSimulation(text)).toThrow("discovery_failed");
});

it.each(["Purg\tfoo", "Purg"])(
	"retains the removal reason for malformed %j",
	(line) => {
		// Given/When/Then
		expect(() => parseAptSimulation(`${install}\n${line}\n`)).toThrow(
			"removals_required",
		);
	},
);
