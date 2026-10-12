import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSlotSyncEvidence } from "../modules/system/update-orchestrator/slot-sync-state.ts";
import { readStoredStateFile } from "../modules/system/update-orchestrator/stored-state-file.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

let root: string;
const openSync = fs.openSync;
const bunFile = Bun.file;
let restorePaths = () => {};
const metadata = 'NAME=Debian\nBUILD_ID="known-image"\n';

beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "slot-sync-layout-"));
	for (const path of ["etc/rauc", "usr/lib", "var/lib/dpkg"])
		fs.mkdirSync(join(root, path), { recursive: true });
	fs.writeFileSync(join(root, "usr/lib/os-release"), metadata);
	fs.writeFileSync(join(root, "var/lib/dpkg/status"), "Package: cerastream\n");
	fs.writeFileSync(join(root, "etc/rauc/system.conf"), "[system]\n");
	fs.writeFileSync(
		join(root, "boot-id"),
		"11111111-1111-4111-8111-111111111111",
	);
	// Remap only the root descriptor and the kernel boot-id path. All production
	// directory walks, no-follow opens, bounded reads and evidence assembly run.
	const rootOpen = spyOn(fs, "openSync").mockImplementation(
		(path, flags, mode) => openSync(path === "/" ? root : path, flags, mode),
	);
	const boot = spyOn(Bun, "file").mockImplementation((path, options) => {
		if (typeof path === "string")
			return bunFile(
				path === "/proc/sys/kernel/random/boot_id"
					? join(root, "boot-id")
					: path,
				options,
			);
		if (typeof path === "number") return bunFile(path, options);
		if (path instanceof URL) return bunFile(path, options);
		return bunFile(path, options);
	});
	restorePaths = () => {
		rootOpen.mockRestore();
		boot.mockRestore();
	};
});

afterEach(() => {
	restorePaths();
	fs.rmSync(root, { recursive: true, force: true });
});

test.each(["regular", "../usr/lib/os-release", "/usr/lib/os-release"])(
	"evidence assembly reads known build identity when os-release is %s",
	async (layout) => {
		// Given identical metadata in each legitimate image layout.
		const path = join(root, "etc/os-release");
		if (layout === "regular") fs.writeFileSync(path, metadata);
		else fs.symlinkSync(layout, path);
		// When production evidence is assembled.
		const evidence = await readSlotSyncEvidence();
		// Then link and regular-file layouts have the same positive build evidence.
		expect(evidence.buildId).toBe("known-image");
		expect(evidence.bootId).toBe("11111111-1111-4111-8111-111111111111");
	},
);

test.each([
	"loop",
	"wrong-target",
	"near-target",
	"dangling",
	"directory",
	"fifo",
	"target-link",
	"target-directory",
	"target-fifo",
	"invalid-utf8",
	"oversize",
])(
	"evidence assembly refuses %s metadata without changing its entry",
	async (layout) => {
		// Given a present entry that cannot be positive OS metadata.
		const path = join(root, "etc/os-release");
		const target = join(root, "usr/lib/os-release");
		if (layout === "loop") fs.symlinkSync("os-release", path);
		else if (layout === "wrong-target")
			fs.symlinkSync("../var/lib/dpkg/status", path);
		else if (layout === "near-target")
			fs.symlinkSync("../usr/lib/./os-release", path);
		else if (layout === "directory") fs.mkdirSync(path);
		else if (layout === "fifo") {
			expect((await runTestCommand(["mkfifo", path])).code).toBe(0);
		} else {
			fs.symlinkSync("../usr/lib/os-release", path);
			fs.unlinkSync(target);
			if (layout === "target-link") fs.symlinkSync("os-release", target);
			else if (layout === "target-directory") fs.mkdirSync(target);
			else if (layout === "target-fifo") {
				expect((await runTestCommand(["mkfifo", target])).code).toBe(0);
			} else if (layout === "invalid-utf8")
				fs.writeFileSync(target, Buffer.from([0xff]));
			else if (layout === "oversize")
				fs.writeFileSync(target, "x".repeat(16_385));
		}
		const inode = fs.lstatSync(path).ino;
		// When production assembly attempts to consume it.
		await expect(readSlotSyncEvidence()).rejects.toThrow();
		// Then the entry is retained, never repaired by the observer.
		expect(fs.lstatSync(path).ino).toBe(inode);
	},
);

test("generic authority still refuses the legitimate metadata symlink", async () => {
	// Given a standard metadata link at an authority path.
	fs.symlinkSync("../usr/lib/os-release", join(root, "etc/os-release"));
	// When the generic primitive reads it, no metadata exception applies.
	await expect(readStoredStateFile("/etc/os-release")).rejects.toThrow();
});
