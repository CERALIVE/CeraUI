import type { UsbNetClass } from "./usb-net-classifier.ts";

/**
 * Physical facts for both router-class and MM-managed devices, so identity
 * survives changes in USB composition. Not part of the netif wire payload.
 */
export type UsbPhysicalDescriptor = {
	ifname: string;
	vid: string;
	pid: string;
	vendor: string;
	model: string;
	deviceClass: UsbNetClass;
	serial?: string;
	legacyLinkId?: string;
	rejectedSharedSerial?: true;
	/** Resolved sysfs USB parent; grouping only, never a stable_key override. */
	usbParent: string;
	idPath?: string;
	hwdbVendor?: string;
	hwdbModel?: string;
	pinManufacturer?: string | undefined;
	pinProduct?: string | undefined;
};

// Keep readers independent of the scan, which calls bond reconciliation on commit.
let descriptors = new Map<string, UsbPhysicalDescriptor>();

export function getUsbPhysicalDescriptor(
	ifname: string,
): UsbPhysicalDescriptor | undefined {
	return descriptors.get(ifname);
}

export function getUsbPhysicalDescriptors(): ReadonlyMap<
	string,
	UsbPhysicalDescriptor
> {
	return descriptors;
}

export function replaceUsbPhysicalDescriptors(
	next: Map<string, UsbPhysicalDescriptor>,
): void {
	descriptors = next;
}

export function deleteUsbPhysicalDescriptor(ifname: string): boolean {
	return descriptors.delete(ifname);
}
