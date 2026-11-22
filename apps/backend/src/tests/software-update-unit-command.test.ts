import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import { softwareUpdateOutputPaths } from "../modules/system/software-update-output.ts";
import {
	buildDetachedAptAllCommand,
	buildDetachedAptUpgradeCommand,
} from "../modules/system/software-update-service.ts";

// APT 3.0.3 turns a failed status-descriptor write into its pending error and
// fails the install after dpkg ran (apt-pkg/contrib/fileutl.cc FileFd::Write,
// apt-private/private-install.cc), and a pipe can block it behind its reader.
// So the unit gives APT no such descriptor at all: progress is read from the
// unit's stdout file, which systemd writes and nothing in CeraUI can block.
const FAKE_APT = `#!/bin/bash
if { : >&3; } 2>/dev/null; then echo descriptor-3 >> "$WRITES"; fi
case " $* " in *Status-Fd*) echo status-option >> "$WRITES";; esac
echo ran >> "$WRITES"
exit "$FAKE_EXIT"
`;

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "unit-command-"));
	await writeFile(join(dir, "apt-get"), FAKE_APT);
	await chmod(join(dir, "apt-get"), 0o755);
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const paths = softwareUpdateOutputPaths();
const directArgs = [
	"-y",
	"-o",
	"Dpkg::Options::=--force-confdef",
	"-o",
	"Dpkg::Options::=--force-confold",
	"install",
	"cerastream",
];
const afterRun = (command: string[]) =>
	command.slice(command.indexOf("--") + 1);
const forms = {
	// flock's lock is not under test; the command after it runs as systemd would.
	pinned: buildDetachedAptAllCommand(
		buildAptAllInstallArgs([{ name: "cerastream", version: "2" }], "any"),
		"any",
		paths,
	).slice(-3),
	// Everything systemd-run is told to run, whatever shape the command has.
	direct: afterRun(buildDetachedAptUpgradeCommand(directArgs, paths)),
};

test.each([
	["pinned", "0"],
	["pinned", "100"],
	["direct", "0"],
	["direct", "100"],
] as const)(
	"%s: APT runs with no telemetry descriptor and exit %s passes through",
	async (form, exit) => {
		const argv = forms[form].map((arg) =>
			arg.replaceAll("/usr/bin/apt-get", join(dir, "apt-get")),
		);
		const unit = Bun.spawn(argv, {
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				WRITES: join(dir, "writes"),
				FAKE_EXIT: exit,
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(await unit.exited).toBe(Number(exit));
		const runs = form === "pinned" && exit === "0" ? 2 : 1;
		expect(
			(await readFile(join(dir, "writes"), "utf8")).trim().split("\n"),
		).toEqual(Array(runs).fill("ran"));
	},
);
