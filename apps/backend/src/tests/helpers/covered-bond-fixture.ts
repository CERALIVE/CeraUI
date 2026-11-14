import { refreshUsbNetMarkers } from "../../modules/network/router-cellular-scan.ts";

/** Existing identity fixtures supply their own resolver; the scan still completes. */
export function coverBondInterfaces(
	ifnames: readonly string[],
): Promise<boolean> {
	return refreshUsbNetMarkers(ifnames, {
		sysfsRoot: "/",
		udevDataRoot: "/run/udev/data",
		listDir: async () => [],
		readAttr: async () => undefined,
		resolveLink: async () => undefined,
		readLinkName: async () => undefined,
	});
}
