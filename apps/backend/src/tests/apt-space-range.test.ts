import { expect, test } from "bun:test";
import {
	type AptSpaceDeps,
	preflightAptSpace,
} from "../modules/system/apt-space-admission.ts";

test("reports root requirement overflow even when the separate archive volume is short", async () => {
	// Given two devices, a short archive volume, and net growth whose reserve overflows.
	const deps: AptSpaceDeps = {
		run: async (argv) => ({
			exitCode: 0,
			stdout:
				argv[0] === "/usr/bin/apt-config"
					? "ARCHIVES='/cache/';"
					: "After this operation, 9007199254740991 B of additional disk space will be used.\n'https://repo.invalid/a.deb' a.deb 1 SHA256:abc\n",
			stderr: "",
		}),
		stat: async (path) => ({ dev: path === "/" ? 1n : 2n }),
		statfs: async () => ({ bavail: 0n, bsize: 1n }),
	};
	// When admission evaluates both requirements, then arithmetic failure outranks capacity.
	await expect(
		preflightAptSpace(["-y", "install", "cerastream"], deps),
	).rejects.toMatchObject({
		reason: "value_out_of_range",
	});
});
