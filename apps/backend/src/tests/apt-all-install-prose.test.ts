/// <reference types="bun" />

import { expect, it } from "bun:test";
import {
	assertPinnedInstallSimulation,
	parseAptSimulation,
} from "../modules/system/apt-all-packages.ts";

const pairs = [
	{ name: "libfoo2", version: "2.0-1" },
	{ name: "nginx", version: "1.26.3-3+deb13u10" },
];
const fixture = await Bun.file(
	new URL("./fixtures/apt/install-weak-dependencies.txt", import.meta.url),
).text();

it("accepts the exact pinned set when install prints weak-dependency prose", () => {
	// Given: real apt-get headings with reviewer-supplied package identities.
	// When/Then: indented weak dependencies are context, never targets.
	expect(() => assertPinnedInstallSimulation(fixture, pairs)).not.toThrow();
	expect(parseAptSimulation(fixture)).toEqual(pairs);
});

it("accepts the pinned install when apt's successful fallback solver prints progress", () => {
	// Given: the board's exact progress bytes in an otherwise successful install replay.
	// apt 3.0.3 private-install.cc:983-1035 and edsp.cc:791-799 (45bebdfb).
	const text = fixture.replace(
		"The following additional packages will be installed:",
		"Solving dependencies...\nThe following additional packages will be installed:",
	);
	// When/Then: the fallback's progress does not alter the pinned authority.
	expect(() => assertPinnedInstallSimulation(text, pairs)).not.toThrow();
	expect(parseAptSimulation(text)).toEqual(pairs);
});

// All 54 literals from the independent apt 3.0.3 source census. Action tokens
// are not prose; they must still refuse even beside an otherwise valid plan.
const actionTokens = [
	"Conf ",
	"Conf Broken nginx",
	"Inst ",
	"Purg ",
	"Purg",
	"Remv ",
	"Remv",
];
const prose = [
	"Done",
	"Show Scores",
	"Candidate versions",
	"Dependency generation",
	"Drop obsolete section with ",
	"Hold prevents Mark",
	"Hold",
	"Keep",
	"Done ordering",
	"This installation run will require temporarily ",
	"Size violation detected in pkgCache::Header",
	"This APT does not support the versioning system 'nginx'",
	"Calculating upgrade",
	"This may mean that the package is missing, has been obsoleted, or",
	"Most used commands:",
	"This APT has Super Cow Powers.",
	"This APT helper has Super Meep Powers.",
	"Some packages could not be authenticated",
	"Aborting install.",
	"Broken packages",
	"Held packages were changed and -y was used without --allow-change-held-packages.",
	"More space needed in nginx than available: nginxB > nginxB, installation may fail",
	"More space needed than available: nginxB > nginxB, installation may fail",
	"Need to get nginxB of archives.",
	"Need to get nginxB/nginxB of archives.",
	"Recommended packages:",
	"Save ",
	"Some files failed to download",
	"Some packages could not be installed. This may mean that you have",
	"Some packages may have been kept back due to phasing.",
	"Suggested packages:",
	"Installing dependencies:",
	"Not upgrading:",
	"This should NOT be done unless you know exactly what you are doing!",
	"Unsatisfied dependencies:",
	"Must specify at least one package to check builddeps for",
	"Must specify at least one package to fetch source for",
	"Need to get nginxB of source archives.",
	"Need to get nginxB/nginxB of source archives.",
	"Please use:",
	"Some sources can be modernized. Run 'apt modernize-sources' to do so.",
	"Reinstall packages (pkg is libc6 not libc6.deb)",
	"Remove packages",
	"Supported modules:",
	"This command is deprecated. Please use 'apt-mark auto' and 'apt-mark manual' instead.",
	"Date",
	"Target nginx (nginx) is configured multiple times in nginx and nginx",
];

it.each(prose)(
	"preserves pinned authority when apt source prose is %j",
	(line) => {
		// Given
		const text = `${line}\nInst nginx (1 Debian [arm64])\n`;
		// When/Then
		expect(() =>
			assertPinnedInstallSimulation(text, [{ name: "nginx", version: "1" }]),
		).not.toThrow();
	},
);

it.each(actionTokens)(
	"refuses incomplete action tokens rather than hiding %j as prose",
	(line) => {
		// Given
		const text = `${line}\nInst nginx (1 Debian [arm64])\n`;
		// When/Then
		expect(() => parseAptSimulation(text)).toThrow();
	},
);
