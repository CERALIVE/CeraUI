import { expect, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import { setPersistentBondOptOut } from "../modules/network/bond-preference.ts";
import { setBondDisableGuardContext } from "../modules/network/network-interfaces.ts";
import { observeRealDeviceAtBoot } from "../modules/system/device-detection.ts";
import {
	addUplinks,
	at,
	b,
	configure,
	file,
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

installBondPortFixture();

test("auto-detected emulation saves only the exact legacy OFF bytes", async () => {
	await onRealDevice(async () => {
		const forced = process.env.CERALIVE_DEVICE_TYPE;
		delete process.env.CERALIVE_DEVICE_TYPE;
		try {
			const absent = async () => "";
			const observer = observeRealDeviceAtBoot(false, {
				isDevelopment: () => false,
				getDeviceTypeOverride: () => process.env.CERALIVE_DEVICE_TYPE,
				readDeviceTreeCompatible: absent,
				readDeviceTreeModel: absent,
				readCeraliveRelease: absent,
				readDmiProductName: absent,
				readDmiBoardName: absent,
			});
			expect(await observer.ready).toBe(false);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(observer.isStillReal()).toBe(false);
			setBondDisableGuardContext(observer, true);
			await start({});
			await scan(at(b, ""));
			addUplinks();
			const port = portId(b);
			// Capture the legacy writer's full file, including defaults and ordering.
			setPersistentBondOptOut(second, true, "legacy");
			const expected = await Bun.file(file).text();
			expect(getConfig().bond_opt_out).toEqual({ [port]: true });
			await start({});
			await scan(at(b, ""));
			expect(await configure(second, "198.51.100.2", false)).toMatchObject({
				success: true,
				applied: { enabled: false },
			});
			expect(await Bun.file(file).text()).toBe(expected);
		} finally {
			if (forced !== undefined) process.env.CERALIVE_DEVICE_TYPE = forced;
		}
	});
});

test("auto-emulation honors ON after an OFF made while boot evidence was pending", async () => {
	await onRealDevice(async () => {
		const forced = process.env.CERALIVE_DEVICE_TYPE;
		delete process.env.CERALIVE_DEVICE_TYPE;
		const evidence = Promise.withResolvers<string>();
		try {
			await start({});
			await scan(at(b, ""));
			addUplinks();
			const absent = async () => "";
			const observer = observeRealDeviceAtBoot(false, {
				isDevelopment: () => false,
				getDeviceTypeOverride: () => undefined,
				readDeviceTreeCompatible: () => evidence.promise,
				readDeviceTreeModel: absent,
				readCeraliveRelease: absent,
				readDmiProductName: absent,
				readDmiBoardName: absent,
			});
			setBondDisableGuardContext(observer, true);
			expect(observer.isStillReal()).toBe(true);
			expect(await configure(second, "198.51.100.2", false)).toMatchObject({
				success: true,
				applied: { enabled: false },
			});
			evidence.resolve("");
			expect(await observer.ready).toBe(false);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(observer.isStillReal()).toBe(false);
			expect(await configure(second, "198.51.100.2", true)).toMatchObject({
				success: true,
				applied: { enabled: true },
			});
			expect(senders()).toEqual(["eth0", second]);
			await reload();
			await readOnlyScan(at(b, ""));
			expect(senders()).toEqual(["eth0", second]);
		} finally {
			evidence.resolve("");
			if (forced !== undefined) process.env.CERALIVE_DEVICE_TYPE = forced;
		}
	});
});

test.each(["", "UNIQUE-BEFORE-EMULATION"])(
	"an emulated boot can undo a prior real OFF with serial %j",
	async (serial) => {
		await onRealDevice(async () => {
			const forced = process.env.CERALIVE_DEVICE_TYPE;
			delete process.env.CERALIVE_DEVICE_TYPE;
			try {
				await start({});
				await scan(at(b, serial));
				addUplinks();
				expect(await configure(second, "198.51.100.2", false)).toMatchObject({
					success: true,
					applied: { enabled: false },
				});
				process.env.CERALIVE_DEVICE_TYPE = "emulated";
				await reload();
				await readOnlyScan(at(b, serial));
				expect(await configure(second, "198.51.100.2", true)).toMatchObject({
					success: true,
					applied: { enabled: true },
				});
				expect(senders()).toEqual(["eth0", second]);
				await reload();
				await readOnlyScan(at(b, serial));
				expect(senders()).toEqual(["eth0", second]);
				delete process.env.CERALIVE_DEVICE_TYPE;
				await reload();
				await readOnlyScan(at(b, serial));
				expect(senders()).toEqual(["eth0", second]);
			} finally {
				if (forced === undefined) delete process.env.CERALIVE_DEVICE_TYPE;
				else process.env.CERALIVE_DEVICE_TYPE = forced;
			}
		});
	},
);
