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

import fs from "node:fs";

import { setup } from "./setup.ts";
import { getPasswordHash, setPasswordHash } from "./auth.ts";
import { getSshPasswordHash, setSshPasswordHash } from "./ssh.ts";

const CONFIG_FILE = "config.json";

let config: {
	password?: string;
	password_hash?: string;
	ssh_pass?: string;
	ssh_pass_hash?: string;
	relay_server?: string;
	relay_account?: string;
	srt_streamid?: string;
	srt_latency?: number;
	srtla_addr?: string;
	srtla_port?: number;
	asrc?: string;
	acodec?: string;
	bitrate_overlay?: boolean;
	remote_key?: string;
	max_br?: number;
	delay?: number;
	pipeline?: string;
} = {};

export function loadConfig() {
	try {
		config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
		console.log(config);
		setPasswordHash(config.password_hash!);
		setSshPasswordHash(config.ssh_pass_hash!);
		delete config.password_hash;
		delete config.ssh_pass_hash;
	} catch (err: unknown) {
		if (err instanceof Error) {
			console.error(
				`Failed to open the config file: ${err.message}. Creating an empty config`,
			);
		}
		config = {};

		// Configure the default audio source depending on the platform
		switch (setup.hw) {
			case "jetson":
				config.asrc = fs.existsSync("/dev/hdmi_capture") ? "HDMI" : "C4K";
				break;
			case "rk3588":
				config.asrc = fs.existsSync("/dev/hdmirx") ? "HDMI" : "USB audio";
				break;
		}
	}
}

export function saveConfig() {
	fs.writeFileSync(
		CONFIG_FILE,
		JSON.stringify({
			...config,
			password_hash: getPasswordHash(),
			ssh_pass_hash: getSshPasswordHash(),
		}),
	);
}

export function getConfig() {
	return config;
}
