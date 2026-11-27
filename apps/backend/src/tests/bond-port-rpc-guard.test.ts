import { expect, test } from "bun:test";
import { getNetworkInterfaces } from "../modules/network/network-interfaces.ts";
import {
	a,
	addUplinks,
	at,
	b,
	configure,
	type Device,
	first,
	g1,
	included,
	installBondPortFixture,
	onRealDevice,
	readOnlyScan,
	reload,
	scan,
	second,
	senders,
	start,
} from "./helpers/bond-port-record-fixture.ts";
import { clearBondNetworkFixture } from "./helpers/bond-toggle-fixture.ts";

installBondPortFixture();

test.each(["restored ON", "untouched exclusion"] as const)(
	"the guard refuses to disable the Huawei alongside a twin with %s",
	async (scenario) => {
		const x = onPci(
			{ ...b, ifname: "wwx0", idVendor: "12d1", idProduct: "1506" },
			"4",
			"PORT-RECORD-HUAWEI-UNIQUE",
		);
		await onRealDevice(async () => {
			if (scenario === "restored ON") {
				await scan(at(b, ""), x);
				addUplinks(x.ifname);
				expect(await configure(second, "198.51.100.2", true)).toMatchObject({
					success: true,
				});
				await scan(at(b, g1), x);
			} else {
				await scan(at(b, g1));
				addUplinks();
				expect(await configure(second, "198.51.100.2", false)).toMatchObject({
					success: true,
				});
				await reload();
				clearBondNetworkFixture();
				await scan(at(a, g1), x);
				addUplinks(x.ifname);
				delete getNetworkInterfaces()[second];
			}
			expect(await configure("eth0", "192.0.2.1", false)).toMatchObject({
				success: true,
			});
			expect(await configure(x.ifname, "198.51.100.3", false)).toEqual({
				success: false,
				error: "disable_all_refused",
			});
			expect(senders()).toContain(x.ifname);
		});
	},
);

function onPci(device: Device, port: string, serial: string): Device {
	return {
		...device,
		serial,
		busnum: "1",
		devpath: port,
		readlink: `/sys/devices/pci0000:00/0000:00:14.0/usb1/1-${port}/1-${port}:1.0`,
		udevadm: {
			...device.udevadm,
			ID_PATH: `pci-0000:00:14.0-usb-0:${port}:1.0`,
		},
	};
}

test.each([
	["both twins attached", true],
	["the sibling unplugged", false],
] as const)(
	"F1: a PCI twin turned ON through the RPC with %s stays in after restart",
	async (_name, both) => {
		const twins = [onPci(a, "3", g1), onPci(b, "4", g1)] as const;
		await scan(...(both ? twins : [twins[1]]));
		addUplinks();
		expect(
			await onRealDevice(() => configure(second, "198.51.100.2", true)),
		).toEqual({
			success: true,
			applied: { name: second, ip: "198.51.100.2", enabled: true },
		});
		await reload();
		await readOnlyScan(...twins);
		expect(included(first, second)).toEqual([false, true]);
	},
);

test("F2: an empty config still allows a serial-less PCI modem as the sole fallback", async () => {
	await start({});
	await scan(onPci(b, "4", ""));
	addUplinks();
	expect(
		await onRealDevice(() => configure("eth0", "192.0.2.1", false)),
	).toMatchObject({ success: true });
	expect(senders()).toEqual([second]);
});
