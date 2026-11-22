import { expect, spyOn, test } from "bun:test";
import fs, { chmodSync, readFileSync, statSync } from "node:fs";
import { logger } from "../helpers/logger.ts";
import {
	getConfig,
	saveConfig,
	saveConfigInBackground,
} from "../modules/config.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	B,
	enabled,
	G,
	noSerialB,
	plug,
	publish,
	reload,
	seed,
	toggle,
	twinA,
	twinB,
	useBondTwinFixture,
} from "./helpers/bond-twin-residual-fixture.ts";

const fixture = useBondTwinFixture();

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

test("a synchronous config save supersedes an older scan snapshot waiting to rename", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	const dir = fixture.dir();
	const { promise: ready, resolve: staged } = Promise.withResolvers<void>();
	const { promise: release, resolve: unblock } = Promise.withResolvers<void>();
	const realRename = fs.promises.rename;
	const rename = spyOn(fs.promises, "rename").mockImplementation(
		async (from, to) => {
			if (typeof from === "string" && from.startsWith(dir)) {
				staged();
				await release;
			}
			return realRename(from, to);
		},
	);
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
		rename.mockRestore();
	}
});
