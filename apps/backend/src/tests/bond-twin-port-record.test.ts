import { expect, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import { setPersistentBondOptOut } from "../modules/network/bond-preference.ts";
import {
	a,
	addUplinks,
	at,
	b,
	configure,
	type Device,
	digest,
	first,
	G1,
	G2,
	g1,
	g2,
	huawei,
	included,
	installBondPortFixture,
	onRealDevice,
	PLACEHOLDER,
	pairKey,
	pairs,
	portId,
	readOnlyScan,
	reload,
	scan,
	second,
	senders,
	start,
} from "./helpers/bond-port-record-fixture.ts";

installBondPortFixture();

test.each([
	["R5b-A: OFF then ON while the serial is unreadable", "", "81d7", false],
	["R5b-A: OFF while visible, ON while unreadable", "", "81d7", true],
	["R5-H1: ON in another USB mode", "", "81d8", true],
	["ON while the twin reports the 0000 placeholder", "0000", "81d7", false],
] as const)(
	"%s survives restart and the serial returning",
	async (_name, serial, mode, visibleOff) => {
		if (visibleOff) {
			await scan(at(b, g1));
			setPersistentBondOptOut(second, true);
		}
		await scan(at(b, serial, mode));
		if (!visibleOff) setPersistentBondOptOut(second, true);
		setPersistentBondOptOut(second, false);
		await reload();
		await readOnlyScan(at(b, serial, mode));
		expect(included(second)).toEqual([true]);
		await readOnlyScan(at(a, g1), at(b, g1));
		expect(included(first, second)).toEqual([false, true]);
		await reload();
		await readOnlyScan(at(b, g1), at(a, g1));
		expect(included(first, second)).toEqual([false, true]);
	},
);

test("R5b-A strand: an ON twin stays the sole sender when its serial returns", async () => {
	await onRealDevice(async () => {
		await scan(at(b, ""));
		addUplinks();
		setPersistentBondOptOut(second, true);
		setPersistentBondOptOut(second, false);
		expect(await configure("eth0", "192.0.2.1", false)).toMatchObject({
			success: true,
		});
		await readOnlyScan(at(b, g1));
		expect(senders()).toEqual([second]);
	});
});

test("R5b-S: a group-less ON follows the same-brand port into another pair", async () => {
	await scan(at(a, g1), at(b, g1));
	setPersistentBondOptOut(second, true);
	await scan(at(b, "", "81d8"));
	setPersistentBondOptOut(second, false);
	await reload();
	await readOnlyScan(at(a, g2), at(b, g2));
	expect(included(first, second)).toEqual([false, true]);
});

test("a same-brand replacement at an ON port inherits it, even from a confirmed pair", async () => {
	await scan(at(a, g1), at(b, g1));
	addUplinks();
	expect(
		await onRealDevice(() => configure(second, "198.51.100.2", true)),
	).toEqual({
		success: true,
		applied: { name: second, ip: "198.51.100.2", enabled: true },
	});
	await reload();
	await readOnlyScan(at(a, g2), at(b, g2));
	expect(included(first, second)).toEqual([false, true]);
});

test.each([
	["an unplugged sibling", false],
	["an OFF on the excluded twin with its sibling unplugged", true],
] as const)("F2-H1: %s stays excluded when it returns", async (_name, off) => {
	await scan(at(a, g1));
	setPersistentBondOptOut(first, off);
	await reload();
	await readOnlyScan(at(a, g1), at(b, g1));
	expect(included(first, second)).toEqual([!off, false]);
});

test("possible twins showing the 0000 placeholder keep their own choices", async () => {
	await start(pairs(PLACEHOLDER));
	await scan(at(a, "0000"));
	setPersistentBondOptOut(first, false);
	await reload();
	await readOnlyScan(at(a, "0000"), at(b, "0000"));
	expect(included(first, second)).toEqual([true, false]);
	await readOnlyScan(at(b, "0000"));
	expect(included(second)).toEqual([true]);
});

test("toggling a sibling keeps an ON twin in and writes main's legacy bytes", async () => {
	await scan(at(b, ""));
	setPersistentBondOptOut(second, false);
	await scan(at(a, g1), at(b, g1));
	setPersistentBondOptOut(first, false);
	expect(JSON.stringify(getConfig().bond_opt_out)).toBe(
		JSON.stringify({ [G2]: true, [portId(b)]: true }),
	);
	await reload();
	await readOnlyScan(at(a, g1), at(b, g1));
	expect(included(first, second)).toEqual([true, true]);
	setPersistentBondOptOut(second, true);
	await reload();
	await readOnlyScan(at(a, g1), at(b, g1));
	expect(included(first, second)).toEqual([true, false]);
});

test("a readable unique-serial OFF beats and clears the same port's ON", async () => {
	await scan(at(b, ""));
	setPersistentBondOptOut(second, false);
	await scan(at(b, "PORT-RECORD-UNIQUE"));
	setPersistentBondOptOut(second, true);
	expect(getConfig().bond_opt_in).toBeUndefined();
	await reload();
	await readOnlyScan(at(b, "PORT-RECORD-UNIQUE"));
	expect(included(second)).toEqual([false]);
	await readOnlyScan(at(a, g1), at(b, g1));
	expect(included(first, second)).toEqual([false, false]);
});

test("a path change loses the port's ON and falls back to the pair default", async () => {
	await scan(at(a, g1), at(b, g1));
	setPersistentBondOptOut(second, false);
	const relabelled = {
		...at(b, g1),
		udevadm: { ...b.udevadm, ID_PATH: "platform-fc400000.usb-usb-0:2:1.0" },
	};
	await readOnlyScan(at(a, g1), relabelled);
	expect(included(first, second)).toEqual([false, false]);
});

test("a port ON does not transfer to a different brand's excluded pair", async () => {
	await start({
		...pairs(G1, pairKey("12d1", huawei)),
		usb_serial_shared: [digest("413c", g1), digest("12d1", huawei)],
	});
	await scan(at(b, ""));
	setPersistentBondOptOut(second, false);
	const other = (device: Device) => ({
		...at(device, huawei),
		idVendor: "12d1",
		idProduct: "1506",
	});
	await readOnlyScan(other(a), other(b));
	expect(included(first, second)).toEqual([false, false]);
});

test("an ON from another vendor at an aliased path keeps the attached twin ON", async () => {
	const alias = {
		...at(b, ""),
		idVendor: "1e0e",
		udevadm: { ...b.udevadm, ID_PATH: a.udevadm.ID_PATH },
	};
	await scan(at(a, g1), alias);
	setPersistentBondOptOut(first, false);
	expect(included(first)).toEqual([true]);
	setPersistentBondOptOut(second, false);
	expect(included(first, second)).toEqual([true, true]);
});

test("an ON from a different vendor does not erase the previous vendor's port ON", async () => {
	await scan(at(a, g1), at(b, g1));
	setPersistentBondOptOut(first, false);
	expect(included(first, second)).toEqual([true, false]);
	await scan({ ...at(a, ""), idVendor: "1e0e" }, at(b, g1));
	setPersistentBondOptOut(first, false);
	await reload();
	await readOnlyScan(at(a, g1), at(b, g1));
	expect(included(first, second)).toEqual([true, false]);
});

test.each([
	["its own unique serial", "PORT-RECORD-HUAWEI-UNIQUE", true],
	["no serial", "", true],
] as const)(
	"a port OFF leaves another brand with %s IN",
	async (_name, serial, expected) => {
		await start({});
		await scan(at(b, ""));
		addUplinks();
		expect(
			await onRealDevice(() => configure(second, "198.51.100.2", false)),
		).toMatchObject({
			success: true,
			applied: { enabled: false },
		});
		const previousPort = portId(b);
		await reload();
		await readOnlyScan({
			...at(b, serial),
			idVendor: "12d1",
			idProduct: "1506",
		});
		expect(included(second)).toEqual([expected]);
		expect(getConfig().bond_opt_out).toEqual({ [previousPort]: true });
		await readOnlyScan(at(b, ""));
		expect(included(second)).toEqual([false]);
	},
);

test("an acknowledged ON carries over to a lone same-brand 0000 replacement", async () => {
	await onRealDevice(async () => {
		await start(pairs(G1, PLACEHOLDER));
		await scan(at(b, g1));
		addUplinks();
		expect(await configure(second, "198.51.100.2", true)).toMatchObject({
			success: true,
			applied: { enabled: true },
		});
		await reload();
		await readOnlyScan(at(b, "0000"));
		expect(included(second)).toEqual([true]);
		expect(senders()).toContain(second);
	});
});
