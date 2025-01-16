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

import { spawnSync } from "node:child_process";

import { checkExecPath } from "./helpers/exec.ts";

import { updateAudioDevices } from "./modules/audio.ts";
import { checkCamlinkUsb2 } from "./modules/camlink.ts";
import { loadConfig } from "./modules/config.ts";
import { UPDATE_GW_INT, updateGwWrapper } from "./modules/gateways.ts";
import { initHardwareMonitoring } from "./modules/hardware-monitoring.ts";
import { startHttpServer } from "./modules/http-server.ts";
import { updateModems } from "./modules/modems.ts";
import { initNetworkInterfaceMonitoring } from "./modules/network-interfaces.ts";
import { initRemote } from "./modules/remote.ts";
import { initRevisions } from "./modules/revisions.ts";
import { belacoderExec, srtlaSendExec } from "./modules/streamloop.ts";
import { initWebSocketServer } from "./modules/websocket-server.ts";

/* Disable localization for any CLI commands we run */
process.env.LANG = "C.UTF-8";
process.env.LANGUAGE = "C";

/* Make sure apt-get doesn't expect any interactive user input */
process.env.DEBIAN_FRONTEND = "noninteractive";

checkExecPath(belacoderExec);
checkExecPath(srtlaSendExec);

loadConfig();

initRemote();

initRevisions();
initWebSocketServer();
initHardwareMonitoring();

updateGwWrapper();
setInterval(updateGwWrapper, UPDATE_GW_INT);

updateModems();

initNetworkInterfaceMonitoring();

// check for Cam Links on USB2 at startup
checkCamlinkUsb2();

updateAudioDevices();

/*
  We use an UDEV rule to send a SIGUSR2 when:
   * an Elgato USB device is plugged in or out
   * a USB audio card is plugged in or out
*/
process.on("SIGUSR2", function udevDeviceUpdate() {
	console.log("SIGUSR2");
	checkCamlinkUsb2();
	updateAudioDevices();
});

// make sure we didn't inherit orphan processes
spawnSync("killall", ["belacoder"]);
spawnSync("killall", ["srtla_send"]);

startHttpServer();
