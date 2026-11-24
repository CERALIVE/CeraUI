import { expect, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import { describeModemBondKeys } from "../modules/modems/physical-identity-source.ts";
import {
	a,
	addUplinks,
	at,
	b,
	configure,
	type Device,
	file,
	G1,
	G2,
	included,
	installBondPortFixture,
	onRealDevice,
	portId,
	readOnlyScan,
	reload,
	scan,
	second,
	senders,
	start,
} from "./helpers/bond-port-record-fixture.ts";
import { clearBondNetworkFixture } from "./helpers/bond-toggle-fixture.ts";

installBondPortFixture();

test("an acknowledged unique-serial OFF survives restart with an unreadable serial", async () => {
	await onRealDevice(async () => {
		await start({});
		await scan(at(b, "PORT-RECORD-UNIQUE"));
		addUplinks();
		const serialKey = portId(b);
		expect(await configure(second, "198.51.100.2", false)).toMatchObject({
			success: true,
			applied: { enabled: false },
		});
		await reload();
		clearBondNetworkFixture();
		addUplinks();
		await readOnlyScan(at(b, ""));
		expect(included(second)).toEqual([false]);
		expect(senders()).toEqual(["eth0"]);
		expect(JSON.stringify((await Bun.file(file).json()).bond_opt_out)).toBe(
			JSON.stringify({ [serialKey]: true, [portId(b)]: true }),
		);
	});
});

const huaweiAt = (device: Device, serial = "") => ({
	...at(device, serial),
	idVendor: "12d1",
	idProduct: "1506",
});

test("the first cross-vendor aliased OFF cannot bypass the last-uplink refusal", async () => {
	await onRealDevice(async () => {
		await start({});
		const x = {
			...huaweiAt(a),
			ifname: "wwx0",
			udevadm: b.udevadm,
		};
		await readOnlyScan(at(b, ""), x);
		expect(portId(x)).toBe(portId(b));
		addUplinks(x.ifname);
		expect(await configure("eth0", "192.0.2.1", false)).toMatchObject({
			success: true,
		});
		const bytes = await Bun.file(file).text();
		expect(await configure(x.ifname, "198.51.100.3", false)).toEqual({
			success: false,
			error: "disable_all_refused",
		});
		expect(senders()).toEqual([second, x.ifname]);
		expect(await Bun.file(file).text()).toBe(bytes);
	});
});

test("acknowledged OFF records at one port survive another vendor's OFF", async () => {
	await onRealDevice(async () => {
		await start({});
		addUplinks();
		await scan(at(b, ""));
		const port = portId(b);
		expect(await configure(second, "198.51.100.2", false)).toMatchObject({
			success: true,
			applied: { enabled: false },
		});
		await reload();
		clearBondNetworkFixture();
		addUplinks();
		await readOnlyScan(huaweiAt(b));
		expect(included(second)).toEqual([true]);
		expect(await configure(second, "198.51.100.2", false)).toMatchObject({
			success: true,
			applied: { enabled: false },
		});
		await reload();
		await readOnlyScan(at(b, ""));
		expect(included(second)).toEqual([false]);
		await readOnlyScan(huaweiAt(b));
		expect(included(second)).toEqual([false]);
		expect(getConfig().bond_opt_out).toEqual({ [port]: true });
	});
});

test("an acknowledged port OFF remains effective when the same modem reports a unique serial", async () => {
	await onRealDevice(async () => {
		await start({});
		await scan(at(b, ""));
		addUplinks();
		expect(await configure(second, "198.51.100.2", false)).toMatchObject({
			success: true,
			applied: { enabled: false },
		});
		const port = portId(b);
		await reload();
		clearBondNetworkFixture();
		addUplinks();
		const readable = at(b, "PORT-OFF-BECOMES-UNIQUE");
		await readOnlyScan(readable);
		expect(describeModemBondKeys(second).anchor).toBe("usb-serial");
		expect(senders()).toEqual(["eth0"]);
		expect(await configure(second, "198.51.100.2", true)).toMatchObject({
			success: true,
			applied: { enabled: true },
		});
		await reload();
		await readOnlyScan(at(b, ""));
		expect(included(second)).toEqual([true]);
		expect(getConfig().bond_opt_out).toEqual({ [port]: true });
	});
});

test("a vendor-unknown legacy port OFF still applies to an unreadable replacement", async () => {
	await scan(at(b, ""));
	const port = portId(b);
	await start({ bond_opt_out: { [port]: true } });
	await readOnlyScan(huaweiAt(b));
	expect(included(second)).toEqual([false]);
});

test.each(["", "UNIQUE-REPLACEMENT"])(
	"another vendor's OFF with serial %j does not take ownership of an unknown legacy exclusion",
	async (serial) => {
		await onRealDevice(async () => {
			await scan(at(b, ""));
			const port = portId(b);
			await start({ bond_opt_out: { [port]: true } });
			addUplinks();
			const replacement = { ...at(b, serial), idVendor: "1e0e" };
			await readOnlyScan(replacement);
			expect(included(second)).toEqual([serial !== ""]);
			expect(await configure(second, "198.51.100.2", false)).toMatchObject({
				success: true,
				applied: { enabled: false },
			});
			await reload();
			await readOnlyScan(at(b, ""));
			expect(included(second)).toEqual([false]);
			expect(senders()).toEqual(["eth0"]);
			await readOnlyScan(huaweiAt(b));
			expect(included(second)).toEqual([false]);
			expect(getConfig().bond_opt_out?.[port]).toBe(true);
		});
	},
);

test("a serial OFF appends a rollback bit without disturbing legacy order, and ON clears only its own extra bit", async () => {
	await onRealDevice(async () => {
		const legacy = { [G2]: true, [G1]: true } as const;
		await start({ bond_opt_out: legacy });
		await scan(at(b, ""));
		const port = portId(b);
		const readable = at(b, "PORT-OFF-ROLLBACK");
		await scan(readable);
		const serial = portId(b);
		addUplinks();
		expect(await configure(second, "198.51.100.2", false)).toMatchObject({
			success: true,
			applied: { enabled: false },
		});
		expect(JSON.stringify((await Bun.file(file).json()).bond_opt_out)).toBe(
			JSON.stringify({ ...legacy, [serial]: true, [port]: true }),
		);
		await reload();
		clearBondNetworkFixture();
		addUplinks();
		await readOnlyScan(huaweiAt(b));
		expect(included(second)).toEqual([true]);
		await readOnlyScan(readable);
		expect(await configure(second, "198.51.100.2", true)).toMatchObject({
			success: true,
			applied: { enabled: true },
		});
		expect(JSON.stringify(getConfig().bond_opt_out)).toBe(
			JSON.stringify(legacy),
		);
	});
});
