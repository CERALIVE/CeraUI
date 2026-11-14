import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultRouterCellularScanDeps,
	type LinkRead,
	readNetdevBus,
} from "../modules/network/router-cellular-scan.ts";

for (const bus of ["usb", "pci"]) {
	test(`C9 real temporary symlink tree resolves ${bus}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "t18-c9-"));
		try {
			await mkdir(join(root, "sys/class/net/nic/device"), { recursive: true });
			await symlink(
				`/sys/bus/${bus}`,
				join(root, "sys/class/net/nic/device/subsystem"),
			);
			expect(
				await readNetdevBus("nic", {
					...defaultRouterCellularScanDeps,
					sysfsRoot: root,
				}),
			).toEqual({ kind: "bus", bus });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("C9 real class symlink with no device differs from a vanished name", async () => {
	const root = await mkdtemp(join(tmpdir(), "t18-c9-"));
	try {
		await mkdir(join(root, "sys/class/net"), { recursive: true });
		await mkdir(join(root, "devices/virtual/net/br"), { recursive: true });
		await symlink(
			join(root, "devices/virtual/net/br"),
			join(root, "sys/class/net/br"),
		);
		const deps = { ...defaultRouterCellularScanDeps, sysfsRoot: root };
		expect(await readNetdevBus("br", deps)).toEqual({ kind: "no-device" });
		expect(await readNetdevBus("gone", deps)).toEqual({ kind: "vanished" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const recover of [false, true]) {
	test(`C9 EACCES retry resolves correctly (${recover})`, async () => {
		const calls: string[] = [];
		const result = await readNetdevBus("nic", {
			...defaultRouterCellularScanDeps,
			readLinkResult: async (path): Promise<LinkRead> => {
				calls.push(path);
				return recover && calls.length === 2
					? { ok: true, target: "/sys/bus/usb" }
					: { ok: false, code: "EACCES" };
			},
		});
		expect(result).toEqual(
			recover
				? { kind: "bus", bus: "usb" }
				: { kind: "unreadable", code: "EACCES" },
		);
		expect(calls).toEqual([
			"/sys/class/net/nic/device/subsystem",
			"/sys/class/net/nic/device/subsystem",
		]);
	});
}

test("C9 the class-link probe also retries a non-ENOENT failure", async () => {
	const paths: string[] = [];
	const result = await readNetdevBus("nic", {
		...defaultRouterCellularScanDeps,
		readLinkResult: async (path): Promise<LinkRead> => {
			paths.push(path);
			if (path.endsWith("/device/subsystem"))
				return { ok: false, code: "ENOENT" };
			return paths.length === 2
				? { ok: false, code: "EACCES" }
				: { ok: true, target: "/sys/devices/virtual/net/nic" };
		},
	});
	expect(result).toEqual({ kind: "no-device" });
	expect(paths).toHaveLength(3);
});

for (const code of ["EIO", "ENOMEM", "ELOOP", "ENOTDIR", "EINVAL", "UNKNOWN"]) {
	test(`C9 ${code} is unreadable after exactly one retry`, async () => {
		let calls = 0;
		expect(
			await readNetdevBus("nic", {
				...defaultRouterCellularScanDeps,
				readLinkResult: async () => {
					calls++;
					return { ok: false, code };
				},
			}),
		).toEqual({ kind: "unreadable", code });
		expect(calls).toBe(2);
	});
}

test("C9 an unreadable class-link probe remains unreadable after its retry", async () => {
	const paths: string[] = [];
	expect(
		await readNetdevBus("nic", {
			...defaultRouterCellularScanDeps,
			readLinkResult: async (path) => {
				paths.push(path);
				return {
					ok: false,
					code: path.endsWith("/device/subsystem") ? "ENOENT" : "EACCES",
				};
			},
		}),
	).toEqual({ kind: "unreadable", code: "EACCES" });
	expect(paths).toEqual([
		"/sys/class/net/nic/device/subsystem",
		"/sys/class/net/nic",
		"/sys/class/net/nic",
	]);
});

test("C9 parent teardown can remove subsystem while the netdev and device links still exist", async () => {
	const root = await mkdtemp(join(tmpdir(), "netdev-parent-teardown-"));
	try {
		await mkdir(join(root, "sys/class/net"), { recursive: true });
		await mkdir(join(root, "devices/parent/net/nic"), { recursive: true });
		await symlink(
			join(root, "devices/parent/net/nic"),
			join(root, "sys/class/net/nic"),
		);
		await symlink(
			join(root, "devices/parent"),
			join(root, "devices/parent/net/nic/device"),
		);
		const subsystem = join(root, "devices/parent/subsystem");
		await symlink("/sys/bus/usb", subsystem);
		const deps = { ...defaultRouterCellularScanDeps, sysfsRoot: root };
		expect(await readNetdevBus("nic", deps)).toEqual({
			kind: "bus",
			bus: "usb",
		});
		await unlink(subsystem);
		expect(await readNetdevBus("nic", deps)).toEqual({ kind: "no-device" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
