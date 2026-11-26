import { expect, test } from "bun:test";
import { join } from "node:path";
import { deriveModemStableKey, modemRecoveryPort } from "@ceraui/rpc/schemas";
import { udevPropertyRecords } from "../modules/modems/modem-id-path-source.ts";

const captures = join(import.meta.dir, "fixtures/modems");
const files = [
	...new Bun.Glob("**/*-capture.txt").scanSync(captures),
	"imc-3572/udev.txt",
].sort();

for (const file of files) {
	test(`${file}: captured udev and sysfs spell the same USB port`, async () => {
		const body = await Bun.file(join(captures, file)).text();
		const exported = file.endsWith("udev.txt")
			? body
					.split("\n")
					.map((line) => `E: ${line}`)
					.join("\n")
			: body.slice(body.indexOf("\nP: "));
		const pairs = [...udevPropertyRecords(exported)].flatMap(
			({ path, env }) => {
				const id = env.get("ID_PATH");
				return path !== undefined && id?.includes("-usb-")
					? [[path, id] as const]
					: [];
			},
		);
		expect(pairs.length).toBeGreaterThan(0);
		for (const [path, id] of pairs) {
			expect(
				modemRecoveryPort(id)?.containsDevpath(path),
				`${file}: ${path}`,
			).toBe(true);
		}
	});
}

const synthetic = [
	{
		name: "ARM platform PCIe behind two bridges",
		path: "/devices/platform/fd500000.pcie/pci0000:00/0000:00:00.0/0000:01:00.0/0000:02:00.0/usb3/3-1/3-1.2/3-1.2:1.0/net/eth1",
		id: "platform-fd500000.pcie-pci-0000:02:00.0-usb-0:1.2:1.0",
	},
	{
		name: "native PCI domain and root bus renumber",
		path: "/sys/devices/pci0004:00/0004:00:14.0/usb12/12-3/12-3.2",
		id: "pci-0004:00:14.0-usb-0:3.2",
	},
	{
		name: "dual-role controller in host mode, with external hubs",
		path: "/devices/platform/fc000000.usb/dwc3.0.auto/xhci-hcd.2.auto/usb4/4-2/4-2.10/4-2.10.3",
		id: "platform-xhci-hcd.2.auto-usb-0:2.10.3",
	},
] as const;

for (const { name, path, id } of synthetic) {
	test(`synthetic USB topology: ${name}`, () => {
		expect(modemRecoveryPort(id)?.containsDevpath(path)).toBe(true);
		expect(modemRecoveryPort(id)?.stableKey).toBe(id.replace(/:1\.0$/, ""));
		expect(deriveModemStableKey(id)).toBe(id.replace(/:1\.0$/, ""));
	});
}

test("a hub, sibling port, other PCI domain and gadget do not name the modem's port", () => {
	const port = modemRecoveryPort(
		"platform-fd500000.pcie-pci-0000:02:00.0-usb-0:1.2",
	);
	for (const path of [
		"/devices/pci0000:00/0000:02:00.0/usb1/1-1",
		"/devices/pci0000:00/0000:02:00.0/usb1/1-1.20",
		"/devices/pci0004:00/0004:02:00.0/usb1/1-1.2",
		"/devices/platform/fc000000.usb/dwc3.0.auto/gadget/net/usb0",
	]) {
		expect(port?.containsDevpath(path)).toBe(false);
	}
});
