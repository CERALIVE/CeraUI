import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestCommand } from "./helpers/run-test-command.ts";

const helper = new URL(
	"../../../../deployment/ceralive-nbd-release",
	import.meta.url,
).pathname;
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "ceralive-nbd-release-"));
	roots.push(root);
	const dev = join(root, "dev");
	const sys = join(root, "sys");
	await mkdir(dev);
	await mkdir(sys);
	return {
		dev,
		sys,
		add: async (name: string, size: string) => {
			await mkdir(join(sys, name));
			await Bun.write(join(sys, name, "size"), size);
			await Bun.write(join(sys, name, "dev"), "43:0\n");
			await Bun.write(join(dev, name), "fixture");
		},
		run: async (glob = join(dev, "*"), rdev?: number) => {
			const lines = (await Bun.file(helper).text()).split("\n");
			const devLine = "my $dev_glob = '/dev/nbd[0-9]*';";
			const sysLine = "my $sys_block = '/sys/block';";
			for (const constant of [devLine, sysLine])
				if (lines.filter((line) => line === constant).length !== 1)
					throw new Error("NBD helper production constants are not unique");
			const copy = lines.map((line) => {
				if (line === devLine) return `my $dev_glob = '${glob}';`;
				if (line === sysLine) return `my $sys_block = '${sys}';`;
				if (rdev !== undefined) {
					if (line === "    unless (-b $handle) {") return "    unless (1) {";
					if (line === "    my $rdev = (stat $handle)[6];")
						return `    my $rdev = ${rdev};`;
				}
				return line;
			});
			const path = join(root, "test-nbd-release");
			await Bun.write(path, copy.join("\n"));
			return runTestCommand(["perl", path]);
		},
	};
}

test("no attached device is a successful no-op", async () => {
	// Given an empty private device directory.
	const f = await fixture();
	// When the helper copy executes against the private paths.
	const result = await f.run();
	// Then nothing was attempted.
	expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
});

test("zero-size NBD devices and non-NBD names are ignored", async () => {
	// Given a detached device and tempting non-NBD names with positive sizes.
	const f = await fixture();
	await f.add("nbd0", "0\n");
	await f.add("sda", "100\n");
	await f.add("nbd1p1", "100\n");
	// When the glob includes every fixture file.
	const result = await f.run();
	// Then none receives an ioctl.
	expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
});

test("an attached regular-file stand-in reports ioctl failure and exits nonzero", async () => {
	// Given a positive size, but a file that cannot accept NBD_CLEAR_SOCK.
	const f = await fixture();
	await f.add("nbd12", "2048\n");
	// When only block identity is emulated to exercise the actual failing ioctl.
	const result = await f.run(undefined, 43 * 256);
	// Then failure is visible instead of a false release success.
	expect(result.code).toBe(1);
	expect(result.stdout).toMatch(/nbd12 NBD_CLEAR_SOCK failed:/);
});

test("devices outside the selected glob are never attempted", async () => {
	// Given an attached stand-in excluded by the exact test glob.
	const f = await fixture();
	await f.add("nbd0", "0\n");
	await f.add("nbd1", "2048\n");
	// When only the detached device is selected.
	const result = await f.run(join(f.dev, "nbd0"));
	// Then the attached file outside the glob cannot cause ioctl failure.
	expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
});

test.each(["-1\n", "1x\n", "1\n0\n"])(
	"invalid size %j never authorizes an ioctl",
	async (size) => {
		// Given non-integer whole-file size evidence.
		const f = await fixture();
		await f.add("nbd0", size);
		// When the helper inspects the fixture.
		const result = await f.run();
		// Then no ioctl is attempted.
		expect(result.stdout).not.toContain("NBD_CLEAR_SOCK");
	},
);

test("an NBD-named symlink cannot redirect the ioctl to another path", async () => {
	// Given an NBD-named link to a non-NBD file.
	const f = await fixture();
	await f.add("nbd0", "2048\n");
	await f.add("sda", "2048\n");
	await rm(join(f.dev, "nbd0"));
	await symlink(join(f.dev, "sda"), join(f.dev, "nbd0"));
	// When the helper selects that link.
	const result = await f.run(join(f.dev, "nbd0"));
	// Then the link is refused before ioctl.
	expect(result.code).toBe(1);
	expect(result.stdout).toMatch(/nbd0 open failed:/);
	expect(result.stdout).not.toContain("NBD_CLEAR_SOCK");
});

test.each(["directory", "fifo"] as const)(
	"a %s named nbdN is refused without ioctl",
	async (kind) => {
		// Given a positive sysfs size but a non-block device at the exact name.
		const f = await fixture();
		await f.add("nbd0", "2048\n");
		const path = join(f.dev, "nbd0");
		await rm(path);
		if (kind === "directory") await mkdir(path);
		else expect((await runTestCommand(["mkfifo", path])).code).toBe(0);
		// When the helper opens that node without blocking.
		const result = await f.run();
		// Then it refuses the node type before issuing an ioctl.
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("not a block device");
		expect(result.stdout).not.toContain("NBD_CLEAR_SOCK");
	},
);

test.each([
	[8 * 256, "43:0\n"],
	[43 * 256 + 1, "43:0\n"],
	[43 * 256, "8:0\n"],
	[43 * 256, "43:0\n43:0\n"],
] as const)(
	"device identity %i with sysfs %j is refused before ioctl",
	async (rdev, identity) => {
		// Given an emulated block node with wrong-major, mismatched or ambiguous identity.
		const f = await fixture();
		await f.add("nbd0", "2048\n");
		await Bun.write(join(f.sys, "nbd0", "dev"), identity);
		// When only the fstat result and block predicate are emulated in the private copy.
		const result = await f.run(undefined, rdev);
		// Then the identity guard refuses without attempting release.
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("device identity mismatch");
		expect(result.stdout).not.toContain("NBD_CLEAR_SOCK");
	},
);
