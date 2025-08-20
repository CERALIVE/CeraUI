/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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

/* Check if there are any Cam Links plugged into a USB2 port */
import { readdirP } from "../../helpers/files.ts";
import { logger } from "../../helpers/logger.ts";
import { readTextFile } from "../../helpers/text-files.ts";

import { setup } from "../setup.ts";
import { notificationBroadcast, notificationRemove } from "../ui/notifications.ts";

const deviceDir = setup.usb_device_dir ?? "/sys/bus/usb/devices";

export async function checkCamlinkUsb2() {
	const devices = await readdirP(deviceDir);
	let foundUsb2 = false;

	for (const d of devices) {
		try {
			const vendor = await readTextFile(`${deviceDir}/${d}/idVendor`);
			if (vendor !== "0fd9\n") continue;

			/*
				With my 20GAM9901 unit it would appear that product ID 0x66 is used for
				USB3.0 and 0x67 is used for USB2.0, but I'm not sure if this is consistent
				between different revisions. So we'll check bcdUSB (aka version) for both

				Additional product IDs for 20GAM9902 thanks to chubbybunny627: 0x7b for
				USB 3.0 and 0x85 for USB 2.0
			  */
			const product = ((await readTextFile(`${deviceDir}/${d}/idProduct`)) ?? "").trim();
			const knownCamLinkPids = ["0066", "0067", "007b", "0085"];
			if (!knownCamLinkPids.includes(product)) continue;

			const version = (await readTextFile(`${deviceDir}/${d}/version`)) ?? "";
			if (!version.match("3.00")) {
				foundUsb2 = true;
			}
		} catch (_err) {
			// Silently ignore errors when checking USB device compatibility
		}
	}

	if (foundUsb2) {
		const msg =
			"Detected a Cam Link 4K connected via USB2. This will result in low framerate operation. Ensure that it's connected to a USB3.0 port and that you're using a USB3.0 extension cable.";
		notificationBroadcast("camlink_usb2", "error", msg, 0, true, false);
		logger.info("Detected a Cam Link 4K connected via USB2.0");
	} else {
		notificationRemove("camlink_usb2");
		logger.info("No Cam Link 4K connected via USB2.0");
	}
}
