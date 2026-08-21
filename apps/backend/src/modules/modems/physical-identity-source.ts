/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
  Binding the pure identity resolver to the live device caches.

  `physical-identity.ts` is pure: it decides an identity from an observation and
  reads no device. This module is the one place that ASSEMBLES that observation
  from what the running system last saw, so every consumer of an identity feeds
  the resolver the same facts in the same order.
*/

import { getUsbPhysicalDescriptor } from "../network/router-cellular-scan.ts";

import {
	type PhysicalDeviceRecord,
	type PhysicalObservation,
	resolvePhysicalDevice,
} from "./physical-identity.ts";

/**
 * Resolve the canonical physical record for one interface.
 *
 * The sysfs descriptor sweep (`router-cellular-scan.ts`) is the ONLY source of
 * the vid/pid/serial/hwdb half, and it covers mm-managed devices as well as
 * router-class ones — which is what lets the SAME stick resolve to ONE identity
 * in both of its USB compositions. Everything else (the MM identity, the admin
 * reading) is layered on by the caller that observed it.
 */
export function resolveModemPhysicalIdentity(
	ifname: string,
	extra: Omit<PhysicalObservation, "ifname"> = {},
): PhysicalDeviceRecord {
	const descriptor = getUsbPhysicalDescriptor(ifname);
	return resolvePhysicalDevice({
		ifname,
		...(descriptor !== undefined
			? {
					vid: descriptor.vid,
					pid: descriptor.pid,
					descriptorVendor: descriptor.vendor,
					descriptorModel: descriptor.model,
					...(descriptor.serial !== undefined
						? { serial: descriptor.serial }
						: {}),
					...(descriptor.idPath !== undefined
						? { idPath: descriptor.idPath }
						: {}),
					...(descriptor.hwdbVendor !== undefined
						? { hwdbVendor: descriptor.hwdbVendor }
						: {}),
					...(descriptor.hwdbModel !== undefined
						? { hwdbModel: descriptor.hwdbModel }
						: {}),
				}
			: {}),
		...extra,
	});
}
