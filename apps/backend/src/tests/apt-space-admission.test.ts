import { describe, expect, test } from "bun:test";
import { stat, statfs } from "node:fs/promises";
import type { UpdatePreflightReason } from "@ceraui/rpc";
import {
	APT_SPACE_RESERVE_BYTES,
	type AptSpaceDeps,
	preflightAptSpace,
} from "../modules/system/apt-space-admission.ts";
import {
	aptBytes,
	parseAptSpaceProbe,
} from "../modules/system/apt-space-parser.ts";

const INSTALL = ["-y", "install", "cerastream"];
const TRANSCRIPT = `After this operation, 2 kB of additional disk space will be used.
'https://repo.invalid/a.deb' a.deb 1000 SHA256:abc
'https://repo.invalid/b.deb' b.deb 3000 SHA256:def
`;
const THRESHOLD = 268441456n;

function fixture() {
	const calls: { argv: string[]; opts: Parameters<AptSpaceDeps["run"]>[1] }[] =
		[];
	const state = {
		archiveFree: THRESHOLD,
		rootFree: THRESHOLD,
		archiveDev: 1n,
		rootDev: 1n,
		blockSize: 1n,
		transcript: TRANSCRIPT,
		path: "ARCHIVES='/cache/apt archives/';\n",
		failedCommand: "",
		failedRead: "",
	};
	const deps: AptSpaceDeps = {
		run: async (argv, opts) => {
			calls.push({ argv, opts });
			const key = argv.includes("clean")
				? "clean"
				: argv[0] === "/usr/bin/apt-config"
					? "config"
					: "probe";
			return {
				exitCode: state.failedCommand === key ? 100 : 0,
				stdout:
					key === "config"
						? state.path
						: key === "probe"
							? state.transcript
							: "",
				stderr: "",
			};
		},
		stat: async (path) => {
			if (state.failedRead === "stat") throw new Error("stat unavailable");
			return { dev: path === "/" ? state.rootDev : state.archiveDev };
		},
		statfs: async (path) => {
			if (state.failedRead === "statfs") throw new Error("statfs unavailable");
			return {
				bavail: path === "/" ? state.rootFree : state.archiveFree,
				bsize: state.blockSize,
			};
		},
	};
	return { state, deps, calls };
}

describe("apt admission capacity", () => {
	test("admits at the exact same-device threshold after direct pre-clean", async () => {
		// Given 4000 download + 2000 net growth + the declared reserve.
		const h = fixture();
		// When admission runs against one shared filesystem.
		await preflightAptSpace(INSTALL, h.deps);
		// Then the one probe uses the unchanged argv and a child-local C locale.
		expect(APT_SPACE_RESERVE_BYTES).toBe(268435456);
		expect(h.calls.map((call) => call.argv)).toEqual([
			["/usr/bin/apt-get", "clean"],
			["/usr/bin/apt-config", "shell", "ARCHIVES", "Dir::Cache::archives/d"],
			["/usr/bin/apt-get", "--print-uris", ...INSTALL],
		]);
		expect(h.calls[0]?.opts?.timeoutMs).toBe(30_000);
		expect(h.calls[2]?.opts?.env?.LC_ALL).toBe("C");
	});

	test.each([
		["same device one byte under", 1n, THRESHOLD - 1n, THRESHOLD - 1n],
		["split device root short", 2n, 268439456n, 268437455n],
		["split device archive short", 2n, 268439455n, 268437456n],
	])("refuses when %s", async (_label, archiveDev, archiveFree, rootFree) => {
		// Given independently measured volumes; when admitted; then refuse either short side.
		const h = fixture();
		Object.assign(h.state, { archiveDev, archiveFree, rootFree });
		await expect(preflightAptSpace(INSTALL, h.deps)).rejects.toMatchObject({
			reason: "insufficient_space",
		});
	});

	test("admits when both separate devices exactly meet their own thresholds", async () => {
		// Given split filesystems; when each has its own reserve; then admission succeeds.
		const h = fixture();
		Object.assign(h.state, {
			archiveDev: 2n,
			archiveFree: 268439456n,
			rootFree: 268437456n,
		});
		await expect(preflightAptSpace(INSTALL, h.deps)).resolves.toBeUndefined();
	});

	const failures: readonly [
		UpdatePreflightReason,
		(h: ReturnType<typeof fixture>) => void,
	][] = [
		[
			"apt_config_failed",
			(h) => {
				h.state.failedCommand = "config";
			},
		],
		[
			"archive_path_invalid",
			(h) => {
				h.state.path = "ARCHIVES='relative/archives/'";
			},
		],
		[
			"probe_failed",
			(h) => {
				h.state.failedCommand = "probe";
			},
		],
		[
			"probe_no_uri_rows",
			(h) => {
				h.state.transcript =
					"After this operation, 0 B of additional disk space will be used.";
			},
		],
		[
			"probe_uri_size_malformed",
			(h) => {
				h.state.transcript +=
					"'https://repo.invalid/c.deb' c.deb bad SHA256:ghi\n";
			},
		],
		[
			"probe_delta_malformed",
			(h) => {
				h.state.transcript =
					"'https://repo.invalid/a.deb' a.deb 1000 SHA256:abc";
			},
		],
		[
			"stat_failed",
			(h) => {
				h.state.failedRead = "stat";
			},
		],
		[
			"statfs_failed",
			(h) => {
				h.state.failedRead = "statfs";
			},
		],
		[
			"value_out_of_range",
			(h) => {
				h.state.archiveFree = -1n;
			},
		],
		[
			"pre_clean_failed",
			(h) => {
				h.state.failedCommand = "clean";
			},
		],
	];
	test.each(failures)(
		"fails closed with %s when its input cannot be obtained",
		async (reason, arrange) => {
			// Given exactly one unusable input; when preflight runs; then preserve its specific cause.
			const h = fixture();
			arrange(h);
			await expect(preflightAptSpace(INSTALL, h.deps)).rejects.toMatchObject({
				reason,
			});
		},
	);

	test.each([
		"",
		"ARCHIVES='';",
		"ARCHIVES=/unquoted;",
		"ARCHIVES='/a'; reboot",
		"ARCHIVES='/a\n/b';",
	])("rejects malformed archive assignment %j", async (path) => {
		const h = fixture(); // Given untrusted apt-config output.
		h.state.path = path;
		// When parsed, then never execute it or assume a default directory.
		await expect(preflightAptSpace(INSTALL, h.deps)).rejects.toMatchObject({
			reason: "archive_path_invalid",
		});
	});

	test("rejects overflowing free-space multiplication", async () => {
		const h = fixture(); // Given individually valid factors whose product overflows the byte domain.
		h.state.blockSize = BigInt(Number.MAX_SAFE_INTEGER);
		await expect(preflightAptSpace(INSTALL, h.deps)).rejects.toMatchObject({
			reason: "value_out_of_range",
		});
	});

	test("reads real filesystem metadata through the default stat APIs", async () => {
		// Given the actual archive and root on this test host, with subprocesses safely doubled.
		const h = fixture();
		h.state.path = "ARCHIVES='/';";
		// When real bigint stat/statfs back admission; then a readable ample host admits.
		await expect(
			preflightAptSpace(INSTALL, {
				...h.deps,
				stat: (path) => stat(path, { bigint: true }),
				statfs: (path) => statfs(path, { bigint: true }),
			}),
		).resolves.toBeUndefined();
	});
});

describe("the single print-uris transcript", () => {
	test.each([
		["2 kB of additional disk space will be used", 2000n],
		["1,234 kB of additional disk space will be used", 1234000n],
		["0.0001 kB of additional disk space will be used", 1n],
		["20 MB disk space will be freed", 0n],
	])(
		"parses %s without negative credit or downward rounding",
		(delta, expected) => {
			// Given one transcript; when parsed; then both figures come from that transcript.
			expect(
				parseAptSpaceProbe(
					TRANSCRIPT.replace(
						"2 kB of additional disk space will be used",
						delta,
					),
				),
			).toEqual({
				download_bytes: aptBytes(4000n),
				install_delta_bytes: aptBytes(expected),
			});
		},
	);
	test.each(["many MB", "1 XB", "1,2 MB"])(
		"rejects an unreadable net delta %s",
		(delta) => {
			// Given a malformed size; when parsed; then do not substitute zero.
			expect(() =>
				parseAptSpaceProbe(TRANSCRIPT.replace("2 kB", delta)),
			).toThrow(expect.objectContaining({ reason: "probe_delta_malformed" }));
		},
	);
	test.each(["-1", "9007199254740992"])(
		"rejects an out-of-range URI size %s",
		(size) => {
			// Given signed/overflowing size; when parsed; then reject the complete plan.
			expect(() =>
				parseAptSpaceProbe(TRANSCRIPT.replace("1000 SHA", `${size} SHA`)),
			).toThrow(expect.objectContaining({ reason: "value_out_of_range" }));
		},
	);
});
