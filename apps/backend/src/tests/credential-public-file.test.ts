/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPublicCredentialFile } from "../modules/system/update-orchestrator/credential-public-file.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "public-credential-read-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test("bounded regular public file is readable", async () => {
	// Given a trusted regular file; When read; Then return bytes plus local snapshot identity.
	const path = join(root, "public.crt");
	await writeFile(path, "public", { mode: 0o644 });
	expect(readPublicCredentialFile(path, 64).bytes.toString()).toBe("public");
});

test.each(["symlink", "fifo", "oversize", "writable", "ancestor"] as const)(
	"refuses %s without following or blocking",
	async (kind) => {
		// Given an unsafe public-file boundary.
		const path = join(root, "public.crt");
		switch (kind) {
			case "symlink":
				await symlink("/dev/null", path);
				break;
			case "fifo": {
				const command = Bun.spawn(["mkfifo", path], {
					stdout: "ignore",
					stderr: "ignore",
				});
				expect(await command.exited).toBe(0);
				break;
			}
			case "oversize":
				await writeFile(path, "a".repeat(65));
				break;
			case "writable":
				await writeFile(path, "public");
				await chmod(path, 0o666);
				break;
			case "ancestor": {
				const parent = join(root, "untrusted");
				await mkdir(parent);
				await chmod(parent, 0o777);
				await writeFile(join(parent, "public.crt"), "public");
				break;
			}
			default: {
				const exhaustive: never = kind;
				return exhaustive;
			}
		}
		// When opened; Then refuse the boundary instead of treating it as a cert.
		expect(() =>
			readPublicCredentialFile(
				kind === "ancestor" ? join(root, "untrusted/public.crt") : path,
				64,
			),
		).toThrow();
	},
);
