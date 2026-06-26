/*
    CeraUI - web UI for the CERALIVE project
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

/* Hardware monitoring */
import { logger } from "../../helpers/logger.ts";
import { argMatch, run, SERVICE_RE } from "../../helpers/run.ts";
import { ACTIVE_TO } from "../../helpers/shared.ts";
import { getms } from "../../helpers/time.ts";
import {
	getMockSensorData,
	shouldMockSensors,
} from "../../mocks/providers/sensors.ts";

import { getRTMPIngestStats } from "../ingest/rtmp.ts";
import { getSRTIngestStats } from "../ingest/srt.ts";
import { setup } from "../setup.ts";
import {
	notificationBroadcast,
	notificationExists,
	notificationRemove,
} from "../ui/notifications.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

const bootconfigService = "ceralive-firstboot-bootconfig";

const sensors: Record<string, string> = {};

export function getSensors() {
	return sensors;
}

async function updateSensorThermal(id: number, name: string) {
	try {
		const socTempStr = await Bun.file(
			`/sys/class/thermal/thermal_zone${id}/temp`,
		).text();
		const socTemp = Number.parseInt(socTempStr, 10) / 1000.0;
		sensors[name] = `${socTemp.toFixed(1)} °C`;
	} catch (_err) {
		// missing /sys thermal path → leave the signal unset rather than crash
	}
}

async function updateSensorsJetson() {
	try {
		const socVoltageStr = await Bun.file(
			"/sys/bus/i2c/drivers/ina3221x/6-0040/iio:device0/in_voltage0_input",
		).text();
		const socVoltage = Number.parseInt(socVoltageStr, 10) / 1000.0;
		sensors["SoC voltage"] = `${socVoltage.toFixed(3)} V`;
	} catch (_err) {
		// absent ina3221x rail → skip this signal rather than crash sampling
	}

	try {
		const socCurrentStr = await Bun.file(
			"/sys/bus/i2c/drivers/ina3221x/6-0040/iio:device0/in_current0_input",
		).text();
		const socCurrent = Number.parseInt(socCurrentStr, 10) / 1000.0;
		sensors["SoC current"] = `${socCurrent.toFixed(3)} A`;
	} catch (_err) {
		// absent ina3221x rail → skip this signal rather than crash sampling
	}

	await updateSensorThermal(0, "SoC temperature");
}

async function updateSensorsRk3588() {
	await updateSensorThermal(0, "SoC temperature");
}

async function isServiceEnabled(service: string) {
	try {
		await run("systemctl", ["is-enabled", argMatch(SERVICE_RE, service)]);
		return true;
	} catch (_err) {
		// `systemctl is-enabled` exits non-zero when the unit is disabled/absent.
		return false;
	}
}

async function isServiceFailed(service: string) {
	try {
		await run("systemctl", ["is-failed", argMatch(SERVICE_RE, service)]);
		return true;
	} catch (_err) {
		// `systemctl is-failed` exits non-zero when the unit is not in a failed state.
		return false;
	}
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
		notificationBroadcast(
			"bootconfig",
			"warning",
			msg,
			0,
			true,
			false,
			false,
			"notifications.bootconfigUpdating",
		);
	}

	setTimeout(monitorBootconfig, 2000);
}

export function initHardwareMonitoring() {
	// Use mock sensors in development mode
	if (shouldMockSensors()) {
		const updateMockSensors = () => {
			const data = getMockSensorData();
			const srtIngestStats = getSRTIngestStats();
			if (srtIngestStats) {
				data["SRT ingest"] = srtIngestStats;
			}
			const rtmpIngestStats = getRTMPIngestStats();
			Object.assign(data, rtmpIngestStats);

			broadcastMsg("sensors", data, getms() - ACTIVE_TO);
		};

		updateMockSensors();
		setInterval(updateMockSensors, 1000);
		logger.info("🎭 Using mock hardware sensors");
		return;
	}

	let sensorsFunc: (() => Promise<void>) | undefined;
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
		const updateSensors = async () => {
			await sensorsFunc();

			const data = { ...sensors };
			const srtIngestStats = getSRTIngestStats();
			if (srtIngestStats) {
				data["SRT ingest"] = srtIngestStats;
			}
			const rtmpIngestStats = getRTMPIngestStats();
			Object.assign(data, rtmpIngestStats);

		broadcastMsg("sensors", data, getms() - ACTIVE_TO);
	};

	void updateSensors();
	setInterval(updateSensors, 1000);
	}

	/* Hardware-specific monitoring */
	switch (setup.hw) {
		case "jetson": {
			/* Monitor the kernel log for undervoltage events */
			const dmesg = Bun.spawn(["dmesg", "-w"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			void (async () => {
				const decoder = new TextDecoder();
				for await (const chunk of dmesg.stdout as ReadableStream<Uint8Array>) {
					const data = decoder.decode(chunk);
					if (data.match("soctherm: OC ALARM 0x00000001")) {
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
							true,
							"notifications.jetsonUndervoltage",
						);
					}
				}
		})(); // dmesg

		/* Show an alert while ceralive-firstboot-bootconfig is active */
		void monitorBootconfig();
		break;
		}

		case "rk3588": {
			const dmesg = Bun.spawn(["dmesg", "-w"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			void (async () => {
				const decoder = new TextDecoder();
				for await (const chunk of dmesg.stdout as ReadableStream<Uint8Array>) {
					const data = decoder.decode(chunk);

					if (
						data.match("hdmirx_wait_lock_and_get_timing signal not lock") ||
						data.match("hdmirx_delayed_work_audio: audio underflow")
					) {
						const msg =
							"HDMI signal issues detected. This is usually caused either by EMI or a by a faulty cable. " +
							"Try to move any modems away from the HDMI cable and the encoder. " +
							"If that fails, try out a different HDMI cable or to manually set a lower HDMI resolution/framerate on your camera";
						notificationBroadcast(
							"hdmi_error",
							"error",
							msg,
							8,
							true,
							false,
							true,
							"notifications.hdmiError",
						);
					}

					if (data.match("hdmirx-controller: Err, timing is invalid")) {
						const hdmiNotif = notificationExists("hdmi_error");
						const msg = "No HDMI signal detected";

						if (!hdmiNotif || hdmiNotif.msg === msg) {
							notificationBroadcast("hdmi_error", "error", msg, 3, true, false);
						}
					}
				}
			})();
			break;
		}
	}
}
