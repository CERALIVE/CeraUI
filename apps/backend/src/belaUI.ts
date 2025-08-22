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

import { checkExecPath } from "./helpers/exec.ts";
import killall from "./helpers/killall.ts";
import { logger } from "./helpers/logger.ts";
import { loadConfig } from "./modules/config.ts";
import { initRTMPIngestStats } from "./modules/ingest/rtmp.ts";
import { initSRTIngest } from "./modules/ingest/srt.ts";
import { updateModems } from "./modules/modems/modem-update-loop.ts";
import { UPDATE_GW_INT, updateGwWrapper } from "./modules/network/gateways.ts";
import { initNetworkInterfaceMonitoring } from "./modules/network/network-interfaces.ts";
import { initRemote } from "./modules/remote/remote.ts";
import { setup } from "./modules/setup.ts";
import { updateAudioDevices } from "./modules/streaming/audio.ts";
import { startBcrpt } from "./modules/streaming/bcrpt.ts";
import { checkCamlinkUsb2 } from "./modules/streaming/camlink.ts";
import { initPipelines } from "./modules/streaming/pipelines.ts";
import {
	bcrptExec,
	belacoderExec,
	checkAutoStartStream,
	srtlaSendExec,
} from "./modules/streaming/streamloop.ts";
import { initRevisions } from "./modules/system/revisions.ts";
import { initHardwareMonitoring } from "./modules/system/sensors.ts";
import { periodicCheckForSoftwareUpdates } from "./modules/system/software-updates.ts";
import { getSshStatus } from "./modules/system/ssh.ts";
import { initHttpServer } from "./modules/ui/http-server.ts";
import { initWebSocketServer } from "./modules/ui/websocket-server.ts";

/* Disable localization for any CLI commands we run */
process.env.LANG = "C.UTF-8";
process.env.LANGUAGE = "C";

/* Make sure apt-get doesn't expect any interactive user input */
process.env.DEBIAN_FRONTEND = "noninteractive";

checkExecPath(belacoderExec);
checkExecPath(srtlaSendExec);
checkExecPath(bcrptExec);

loadConfig();

initRemote();
initPipelines();

initRevisions();
initWebSocketServer();
initHardwareMonitoring();
initRTMPIngestStats();
initSRTIngest();
getSshStatus();

updateGwWrapper();
setInterval(updateGwWrapper, UPDATE_GW_INT);

updateModems();

if (setup.apt_update_enabled) {
	periodicCheckForSoftwareUpdates();
}

initNetworkInterfaceMonitoring();

// check for Cam Links on USB2 at startup
checkCamlinkUsb2();

updateAudioDevices();
startBcrpt();

// Don't autostart when restarting belaUI after a software update or after a crash

/*
  We use an UDEV rule to send a SIGUSR2 when:
   * an Elgato USB device is plugged in or out
   * a USB audio card is plugged in or out
*/
process.on("SIGUSR2", function udevDeviceUpdate() {
	logger.error("SIGUSR2");
	checkCamlinkUsb2();
	updateAudioDevices();
});

// make sure we didn't inherit orphan processes
killall(["belacoder"]);
killall(["srtla_send"]);

initHttpServer();
checkAutoStartStream();
