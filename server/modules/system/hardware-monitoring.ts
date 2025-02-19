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

import { spawn } from "node:child_process";
/* Hardware monitoring */
import fs from "node:fs";

import { execPNR } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { ACTIVE_TO } from "../../helpers/shared.ts";
import { getms } from "../../helpers/time.ts";

import { setup } from "../setup.ts";
import {
	notificationBroadcast,
	notificationExists,
	notificationRemove,
} from "../ui/notifications.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

const bootconfigService = "belabox-firstboot-bootconfig";

const sensors: Record<string, string> = {};

export function getSensors() {
	return sensors;
}

function updateSensorThermal(id: number, name: string) {
	try {
		const socTempStr = fs.readFileSync(
			`/sys/class/thermal/thermal_zone${id}/temp`,
			"utf8",
		);
		const socTemp = Number.parseInt(socTempStr, 10) / 1000.0;
		sensors[name] = `${socTemp.toFixed(1)} °C`;
	} catch (err) {}
}

function updateSensorsJetson() {
	try {
		const socVoltageStr = fs.readFileSync(
			"/sys/bus/i2c/drivers/ina3221x/6-0040/iio:device0/in_voltage0_input",
			"utf8",
		);
		const socVoltage = Number.parseInt(socVoltageStr, 10) / 1000.0;
		sensors["SoC voltage"] = `${socVoltage.toFixed(3)} V`;
	} catch (err) {}

	try {
		const socCurrentStr = fs.readFileSync(
			"/sys/bus/i2c/drivers/ina3221x/6-0040/iio:device0/in_current0_input",
			"utf8",
		);
		const socCurrent = Number.parseInt(socCurrentStr, 10) / 1000.0;
		sensors["SoC current"] = `${socCurrent.toFixed(3)} A`;
	} catch (err) {}

	updateSensorThermal(0, "SoC temperature");
}

function updateSensorsRk3588() {
	updateSensorThermal(0, "SoC temperature");
}

async function isServiceEnabled(service: string) {
	const isEnabled = await execPNR(`systemctl is-enabled ${service}`);
	return isEnabled.code === 0;
}

async function isServiceFailed(service: string) {
	const isFailed = await execPNR(`systemctl is-failed ${service}`);
	return isFailed.code === 0;
}

async function monitorBootconfig() {
	if (!(await isServiceEnabled(bootconfigService))) {
		notificationRemove("bootconfig");
		return;
	}

	if (await isServiceFailed(bootconfigService)) {
		const msg =
			"Updating the bootloader failed. Please download the system log from the Advanced / developer menu";
		notificationBroadcast("bootconfig", "error", msg, 0, true, false);
		return;
	}

	if (!notificationExists("bootconfig")) {
		const msg =
			"Don't reset or unplug the system. The bootloader is being updated in the background and doing so may brick your board...";
		notificationBroadcast("bootconfig", "warning", msg, 0, true, false, false);
	}

	setTimeout(monitorBootconfig, 2000);
}

export function initHardwareMonitoring() {
	let sensorsFunc: (() => void) | undefined;
	switch (setup.hw) {
		case "jetson":
			sensorsFunc = updateSensorsJetson;
			break;
		case "rk3588":
			sensorsFunc = updateSensorsRk3588;
			break;
		default:
			logger.warn(`Unknown sensors for ${setup.hw}`);
	}

	if (sensorsFunc) {
		const updateSensors = () => {
			sensorsFunc();
			broadcastMsg("sensors", sensors, getms() - ACTIVE_TO);
		};

		updateSensors();
		setInterval(updateSensors, 1000);
	}

	/* Hardware-specific monitoring */
	switch (setup.hw) {
		case "jetson": {
			/* Monitor the kernel log for undervoltage events */
			const dmesg = spawn("dmesg", ["-w"]);
			dmesg.stdout.on("data", (data) => {
				if (data.toString("utf8").match("soctherm: OC ALARM 0x00000001")) {
					const msg =
						"System undervoltage detected. " +
						"You may experience system instability, " +
						"including glitching, freezes and the modems disconnecting";
					notificationBroadcast(
						"jetson_undervoltage",
						"error",
						msg,
						10 * 60,
						true,
						false,
					);
				}
			}); // dmesg

			/* Show an alert while belabox-firstboot-bootconfig is active */
			monitorBootconfig();
			break;
		}

		case "rk3588": {
			const dmesg = spawn("dmesg", ["-w"]);
			dmesg.stdout.on("data", (buf) => {
				const data = buf.toString("utf8");

				if (
					data.match("hdmirx_wait_lock_and_get_timing signal not lock") ||
					data.match("hdmirx_delayed_work_audio: audio underflow")
				) {
					const msg =
						"HDMI signal issues detected. This is usually caused either by EMI or a by a faulty cable. " +
						"Try to move any modems away from the HDMI cable and the encoder. " +
						"If that fails, try out a different HDMI cable or to manually set a lower HDMI resolution/framerate on your camera";
					notificationBroadcast("hdmi_error", "error", msg, 8, true, false);
				}

				if (data.match("hdmirx-controller: Err, timing is invalid")) {
					const hdmiNotif = notificationExists("hdmi_error");
					const msg = "No HDMI signal detected";

					if (!hdmiNotif || hdmiNotif.msg === msg) {
						notificationBroadcast("hdmi_error", "error", msg, 3, true, false);
					}
				}
			});
			break;
		}
	}
}
