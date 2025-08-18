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

import type { StatusResponseMessage } from "@belaui/server/modules/ui/status.ts";

import { updateModemsState } from "../modems/modems.ts";
import { showRemoteStatus } from "../remote/remote.ts";
/* status updates */
import { updateAudioSrcs } from "../streaming/audio-sources.ts";
import {
	getIsStreaming,
	setIsStreaming,
	updateButton,
} from "../streaming/streaming.ts";
import {
	showSoftwareUpdateStatus,
	showSoftwareUpdates,
} from "../system/software-update.ts";
import { setSshStatus, showSshStatus } from "../system/ssh.ts";
import { updateWifiState } from "../wifi/wifi.ts";
import { showInitialPasswordForm } from "./login.ts";

function updateButtonAndSettingsShow({
	add,
	remove,
	text,
	enabled,
	settingsShow,
}: Parameters<typeof updateButton>[0] & { settingsShow: boolean }) {
	const settingsDivs = document.getElementById("settings");
	if (!settingsDivs) return;

	if (settingsShow) {
		settingsDivs.classList.remove("d-none");
	} else {
		settingsDivs.classList.add("d-none");
	}

	updateButton({ add, remove, text, enabled });
}

export function updateStatus(status: StatusResponseMessage) {
	if (status.is_streaming !== undefined) {
		setIsStreaming(status.is_streaming);
		if (getIsStreaming()) {
			updateButtonAndSettingsShow({
				add: "btn-danger",
				remove: "btn-success",
				text: "Stop",
				enabled: true,
				settingsShow: false,
			});
		} else {
			updateButtonAndSettingsShow({
				add: "btn-success",
				remove: "btn-danger",
				text: "Start",
				enabled: true,
				settingsShow: true,
			});
		}
	}

	if (status.remote) {
		showRemoteStatus(status.remote);
	}

	if (status.set_password) {
		showInitialPasswordForm();
	}

	if (status.available_updates !== undefined) {
		showSoftwareUpdates(status.available_updates);
	}

	if (status.updating !== undefined) {
		showSoftwareUpdateStatus(status.updating);
	}

	if (status.ssh) {
		setSshStatus(status.ssh);
		showSshStatus();
	}

	if (status.wifi) {
		updateWifiState(status.wifi);
	}

	if (status.modems) {
		updateModemsState(status.modems);
	}

	if (status.asrcs) {
		updateAudioSrcs(status.asrcs);
	}
}
