import { expect, spyOn, test } from "bun:test";
import fs, { chmodSync, readFileSync, statSync } from "node:fs";
import { logger } from "../helpers/logger.ts";
import {
	getConfig,
	saveConfig,
	saveConfigInBackground,
} from "../modules/config.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import { persistEthernetRole } from "../modules/network/ethernet-role.ts";
import {
	B,
	enabled,
	G,
	noSerialB,
	plug,
	publish,
	reload,
	seed,
	singletonA,
	toggle,
	twinA,
	twinB,
	useBondTwinFixture,
} from "./helpers/bond-twin-residual-fixture.ts";

const fixture = useBondTwinFixture();

test("F4-amp: a recovering scan cannot persist a rejected operator include", async () => {
	await plug(twinA);
	const port = resolveModemPhysicalIdentity(twinA.ifname).linkId;
	await seed([G, port]);
	await plug(twinA);
	expect(enabled(twinA)).toEqual([false]);

	const dir = fixture.dir();
	chmodSync(dir, 0o500);
	try {
		await expect(toggle(twinA, true)).rejects.toMatchObject({ code: "EACCES" });
	} finally {
		chmodSync(dir, 0o700);
	}

	await plug(twinA, twinB);
	await reload();
	await plug(twinA, twinB);
	expect(enabled(twinA)).toEqual([false]);
});

test("a successful scan pin save does not persist a rejected include for another device", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await plug(singletonA);
	await toggle(singletonA, false);
	const path = fixture.configPath();
	const before = readFileSync(path, "utf8");
	const dir = fixture.dir();
	chmodSync(dir, 0o500);
	try {
		await expect(toggle(singletonA, true)).rejects.toMatchObject({
			code: "EACCES",
		});
	} finally {
		chmodSync(dir, 0o700);
	}

	await plug(twinA, twinB);
	expect(readFileSync(path, "utf8")).not.toBe(before);
	await reload();
	await plug(singletonA, noSerialB);
	expect(enabled(singletonA, noSerialB)).toEqual([false, false]);
});

test("a successful scan pin save does not persist a rejected Ethernet role", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	const dir = fixture.dir();
	chmodSync(dir, 0o500);
	try {
		expect(() => persistEthernetRole("eth1", "shared-lan")).toThrow(/EACCES/);
	} finally {
		chmodSync(dir, 0o700);
	}

	await plug(twinA, twinB);
	await reload();
	expect(getConfig().eth_roles?.eth1).toBeUndefined();
	expect(await plug(twinA, noSerialB)).toEqual([[true, false]]);
});

test("R2: blocked scan pins persist once storage recovers and survive restart without a serial", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await reload();

	const configPath = fixture.configPath();
	const dir = fixture.dir();
	const before = readFileSync(configPath, "utf8");
	chmodSync(dir, 0o500);
	try {
		expect(await plug(twinA, twinB)).toEqual([[true, false]]);
		expect(readFileSync(configPath, "utf8")).toBe(before);
	} finally {
		chmodSync(dir, 0o700);
	}

	// Recovery must not depend on getting a new pin to write.
	await plug(twinA);
	await plug(twinA, twinB);
	const recoveredInode = statSync(configPath).ino;
	await plug(twinA, twinB);
	expect(statSync(configPath).ino).toBe(recoveredInode);
	await reload();
	await plug(twinA, noSerialB);
	expect(resolveModemPhysicalIdentity(B.ifname).legacyLinkId).toBeUndefined();
	expect({
		saved: readFileSync(configPath, "utf8") !== before,
		published: enabled(twinA, noSerialB),
	}).toEqual({ saved: true, published: [true, false] });
});

test("scan publication precedes completion of a blocked config open", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);

	const dir = fixture.dir();
	const { promise: release, resolve: unblock } = Promise.withResolvers<void>();
	const realOpen = fs.promises.open;
	const realOpenSync = fs.openSync;
	const events: string[] = [];
	const asyncOpen = spyOn(fs.promises, "open").mockImplementation(
		async (path, flags, mode) => {
			if (typeof path === "string" && path.startsWith(dir)) {
				events.push("async open pending");
				await release;
			}
			return realOpen(path, flags, mode);
		},
	);
	const syncOpen = spyOn(fs, "openSync").mockImplementation(
		(path, flags, mode) => {
			if (
				typeof path === "string" &&
				path.startsWith(dir) &&
				path.endsWith(".tmp")
			) {
				events.push("synchronous open on scan");
				// Synchronous open cannot wait on a promise released after publication.
				throw Object.assign(new Error("injected blocked open"), {
					code: "EACCES",
				});
			}
			return realOpenSync(path, flags, mode);
		},
	);
	try {
		expect(await publish(twinA, twinB)).toEqual([[true, false]]);
		expect(events).not.toContain("synchronous open on scan");
		await publish(twinB);
		expect(events).toEqual(["async open pending"]);
	} finally {
		unblock();
		await saveConfigInBackground();
		syncOpen.mockRestore();
		asyncOpen.mockRestore();
	}
});

test("read-only failures back off by scan count and warn once until recovery", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	const dir = fixture.dir();
	const path = fixture.configPath();
	const before = readFileSync(path, "utf8");
	const realOpen = fs.promises.open;
	let attempts = 0;
	let readOnly = true;
	const open = spyOn(fs.promises, "open").mockImplementation(
		async (path, flags, mode) => {
			if (typeof path === "string" && path.startsWith(dir)) {
				attempts++;
				if (readOnly)
					throw Object.assign(new Error("injected read-only storage"), {
						code: "EROFS",
					});
			}
			return realOpen(path, flags, mode);
		},
	);
	const warn = spyOn(logger, "warn");
	try {
		expect(await plug(twinA, twinB)).toEqual([[true, false]]);
		await plug(twinA);
		await plug(twinA);
		expect(attempts).toBe(3);
		expect(
			warn.mock.calls.filter(
				(args: readonly unknown[]) =>
					args[0] === "bond: could not persist twin port exclusions",
			),
		).toHaveLength(1);
		expect(readFileSync(path, "utf8")).toBe(before);
		readOnly = false;
		await plug(twinA);
		expect(attempts).toBe(3);
		await plug(twinA);
		expect(attempts).toBe(4);
		await plug(twinA);
		expect(attempts).toBe(4);
		await reload();
		expect(await plug(twinA, noSerialB)).toEqual([[true, false]]);
	} finally {
		open.mockRestore();
		warn.mockRestore();
	}
});

function pauseAfterStaging(dir: string, afterRelease?: () => void) {
	const { promise: ready, resolve: staged } = Promise.withResolvers<void>();
	const { promise: release, resolve: unblock } = Promise.withResolvers<void>();
	const realOpen = fs.promises.open;
	const open = spyOn(fs.promises, "open").mockImplementation(
		async (path, flags, mode) => {
			const file = await realOpen(path, flags, mode);
			if (
				typeof path === "string" &&
				path.startsWith(dir) &&
				path.endsWith(".tmp")
			) {
				const close = file.close.bind(file);
				spyOn(file, "close").mockImplementation(async () => {
					await close();
					staged();
					await release;
					afterRelease?.();
				});
			}
			return file;
		},
	);
	return { ready, unblock, restore: () => open.mockRestore() };
}

test("a synchronous config save supersedes an older staged scan snapshot", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	const { ready, unblock, restore } = pauseAfterStaging(fixture.dir());
	try {
		expect(await publish(twinA, twinB)).toEqual([[true, false]]);
		await ready;
		getConfig().max_br = 4321;
		saveConfig();
		const later = readFileSync(fixture.configPath(), "utf8");
		unblock();
		await saveConfigInBackground();
		expect(readFileSync(fixture.configPath(), "utf8")).toBe(later);
		await reload();
		expect(getConfig().max_br).toBe(4321);
	} finally {
		unblock();
		await saveConfigInBackground();
		restore();
	}
});

test("a config save in the first microtask after the draft check is never overwritten", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	const saved = Promise.withResolvers<void>();
	const { ready, unblock, restore } = pauseAfterStaging(fixture.dir(), () => {
		// The first callback lets the writer resume from close; the second
		// runs after its fence, even if publication incorrectly yields.
		queueMicrotask(() =>
			queueMicrotask(() => {
				try {
					getConfig().max_br = 4321;
					saveConfig();
					saved.resolve();
				} catch (error) {
					saved.reject(error);
				}
			}),
		);
	});
	try {
		await publish(twinA, twinB);
		await ready;
		unblock();
		await saved.promise;
		await saveConfigInBackground();
		await reload();
		expect(getConfig().max_br).toBe(4321);
	} finally {
		unblock();
		await saveConfigInBackground();
		restore();
	}
});

test.each(["save", "load"] as const)(
	"staged scan cleanup EIO cannot block config %s",
	async (operation) => {
		await seed([G]);
		await plug(twinA);
		await toggle(twinA, true);

		const savedBitrate = getConfig().max_br;
		const { ready, unblock, restore } = pauseAfterStaging(fixture.dir());
		const unlink = spyOn(fs.promises, "unlink").mockRejectedValue(
			Object.assign(new Error("injected staged cleanup failure"), {
				code: "EIO",
			}),
		);
		try {
			await publish(twinA, twinB);
			await ready;
			getConfig().max_br = 4321;
			if (operation === "save") {
				saveConfig();
			} else {
				await reload();
				expect(getConfig().max_br).toBe(savedBitrate);
			}
			const contents = readFileSync(fixture.configPath(), "utf8");
			unblock();
			await saveConfigInBackground();
			expect(unlink).toHaveBeenCalledTimes(1);
			expect(readFileSync(fixture.configPath(), "utf8")).toBe(contents);
			await reload();
			expect(getConfig().max_br).toBe(
				operation === "save" ? 4321 : savedBitrate,
			);
		} finally {
			unblock();
			await saveConfigInBackground();
			unlink.mockRestore();
			restore();
		}
	},
);
