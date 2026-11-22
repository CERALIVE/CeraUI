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

const paths = softwareUpdateOutputPaths();
const RECORDS = [
	"pmstatus:dpkg-exec:0.0000:Running dpkg",
	"pmstatus:cerastream:50.0000:Installing cerastream",
];

// APT 3.0.3 ignores SIGPIPE (apt-private/private-main.cc InitSignals) and a
// failed status write sets its pending error, which fails the install after
// dpkg ran (apt-pkg/contrib/fileutl.cc FileFd::Write, private-install.cc). A
// pipe on descriptor 3 could also block APT behind its reader.
const FAKE_APT = `#!/bin/bash
trap '' PIPE
if [ -p /dev/fd/3 ]; then echo pipe >> "$WRITES"; exit 99; fi
failed=0
n=0
for record in ${RECORDS.map((r) => `'${r}'`).join(" ")}; do
	n=$((n + 1))
	if [ "$n" = 2 ] && [ -n "$BARRIER" ] && mkdir "$BARRIER.once" 2>/dev/null; then
		read -r _ < "$BARRIER"
	fi
	printf '%s\\n' "$record" >&3 || failed=1
done
echo "$failed" >> "$WRITES"
[ "$failed" = 0 ] || exit 100
exit "$FAKE_EXIT"
`;

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "status-file-"));
	await writeFile(join(dir, "apt-get"), FAKE_APT);
	await chmod(join(dir, "apt-get"), 0o755);
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const args = buildAptAllInstallArgs(
	[{ name: "cerastream", version: "2" }],
	"any",
);
const forms = {
	// flock's lock is not under test; the shell and its script are run as systemd would.
	pinned: buildDetachedAptAllCommand(args, "any", paths),
	direct: buildDetachedAptUpgradeCommand(
		[
			"-y",
			"-o",
			"Dpkg::Options::=--force-confdef",
			"-o",
			"Dpkg::Options::=--force-confold",
			"install",
			"cerastream",
		],
		paths,
	),
};

async function runUnit(
	form: keyof typeof forms,
	status: string,
	env: { FAKE_EXIT?: string; BARRIER?: string } = {},
) {
	const command = forms[form];
	const [shell, flag, script] = command.slice(-3) as [string, string, string];
	const unit = Bun.spawn(
		[
			shell,
			flag,
			script
				.replaceAll("/usr/bin/apt-get", join(dir, "apt-get"))
				.replaceAll(paths.status, status),
		],
		{
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				WRITES: join(dir, "writes"),
				FAKE_EXIT: "0",
				...env,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [code, stderr] = await Promise.all([
		unit.exited,
		new Response(unit.stderr).text(),
	]);
	const writes = (await readFile(join(dir, "writes"), "utf8").catch(() => ""))
		.trim()
		.split("\n")
		.filter(Boolean);
	return { code, stderr, writes };
}

const invocations = { pinned: 2, direct: 1 } as const;

test.each(["pinned", "direct"] as const)(
	"%s: a status file that cannot be opened still runs APT and keeps its result",
	async (form) => {
		const result = await runUnit(form, join(dir, "missing", "status"));
		expect(result.code).toBe(0);
		expect(result.writes).toEqual(Array(invocations[form]).fill("0"));
	},
);

test.each(["pinned", "direct"] as const)(
	"%s: a status write that fails is APT's own write error, as on a full /run",
	async (form) => {
		const result = await runUnit(form, "/dev/full");
		expect(result.code).toBe(100);
		expect(result.writes).toEqual(["1"]);
	},
);

test.each(["pinned", "direct"] as const)(
	"%s: a status file removed mid-run never fails APT",
	async (form) => {
		const status = join(dir, "status");
		const barrier = join(dir, "barrier.fifo");
		await Bun.spawn(["mkfifo", barrier]).exited;
		const unit = runUnit(form, status, { BARRIER: barrier });
		await Bun.spawn([
			"sh",
			"-c",
			'until [ -s "$1" ]; do sleep 0.01; done; rm "$1"; echo go > "$2"',
			"remove",
			status,
			barrier,
		]).exited;
		const result = await unit;
		expect(result.code).toBe(0);
		expect(result.writes).toEqual(Array(invocations[form]).fill("0"));
	},
);

test.each([
	["pinned", "0"],
	["pinned", "100"],
	["direct", "0"],
	["direct", "100"],
] as const)(
	"%s: a writable status file gets APT's records and exit %s passes through",
	async (form, exit) => {
		const status = join(dir, "status");
		const result = await runUnit(form, status, { FAKE_EXIT: exit });
		expect(result.code).toBe(Number(exit));
		const runs = exit === "0" ? invocations[form] : 1;
		expect(await readFile(status, "utf8")).toBe(
			`${RECORDS.join("\n")}\n`.repeat(runs),
		);
	},
);
