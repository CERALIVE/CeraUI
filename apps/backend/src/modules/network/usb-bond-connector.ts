import { mintLinkId } from "../modems/physical-identity.ts";

const FIXED_CONTROLLER = /^[0-9a-f]{8,16}\.usb$/;
const USB_BUS = /^usb([1-9]\d*)$/;

export function usbBondConnector(usbParent: string): string | undefined {
	const parts = usbParent.split("/");
	const root = parts.findIndex((part) => USB_BUS.test(part));
	if (root < 1 || !parts.includes("platform")) return undefined;
	const controller = parts
		.slice(0, root)
		.findIndex((part) => FIXED_CONTROLLER.test(part));
	const bus = USB_BUS.exec(parts[root] ?? "")?.[1];
	const hops = parts.slice(root + 1);
	if (controller < 0 || bus === undefined || hops.length === 0)
		return undefined;
	let prefix = `${bus}-`;
	const ports: string[] = [];
	for (const hop of hops) {
		if (!hop.startsWith(prefix)) return undefined;
		const port = hop.slice(prefix.length);
		if (!/^[1-9]\d*$/.test(port)) return undefined;
		ports.push(port);
		prefix = `${hop}.`;
	}
	// Kernel parent ancestry names physical downstream ports independently of udev labels.
	return mintLinkId(
		`usb-connector:${parts.slice(0, controller + 1).join("/")}:${ports.join(".")}`,
	);
}
