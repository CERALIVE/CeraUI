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

/* Software updates */
import { type ExecException, exec, spawn, spawnSync } from "node:child_process";

import { execPNR } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { getms, oneHour, oneMinute } from "../../helpers/time.ts";

import { queueUpdateGw } from "../network/gateways.ts";
import { setup } from "../setup.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

let availableUpdates:
	| {
			package_count: number;
			download_size?: string;
	  }
	| null
	| false = setup.apt_update_enabled ? null : false;
let softUpdateStatus: {
	total: number;
	downloading: number;
	unpacking: number;
	setting_up: number;
	result?: string | 0;
} | null = null;
let aptGetUpdating = false;
let aptGetUpdateFailures = 0;
let aptHeldBackPackages: string | undefined;

export function getAvailableUpdates() {
	return availableUpdates;
}

export function getSoftUpdateStatus() {
	return softUpdateStatus;
}

export function isUpdating() {
	return softUpdateStatus != null;
}

function parseUpgradePackageCount(text: string) {
	const upgradedMatch = text.match(/(\d+) upgraded/) as [string, string] | null;
	const newlyInstalledMatch = text.match(/, (\d+) newly installed/) as
		| [string, string]
		| null;
	if (!upgradedMatch || !newlyInstalledMatch) {
		logger.error(
			"parseUpgradePackageCount(): failed to parse the package info",
		);
		return undefined;
	}

	const upgradedCount = Number.parseInt(upgradedMatch[1], 10);
	const newlyInstalledCount = Number.parseInt(newlyInstalledMatch[1], 10);
	return upgradedCount + newlyInstalledCount;
}

function parseUpgradeDownloadSize(text: string) {
	return text.split("Need to get ")[1]?.split(/\/|( of archives)/)[0];
}

// Show an update notification if there are pending updates to packages matching this list
const ceralivePackageList = [
	"ceralive",
	"ceracoder",
	"ceraui",
	"srtla",
	"usb-modeswitch-data",
	"l4t",
];
// Reboot instead of just restarting CeraUI if we've updated packages matching this list
const rebootPackageList = ["l4t", "ceralive-linux-", "ceralive-network-config"];

function packageListIncludes(list: string, includes: Array<string>) {
	for (const p of includes) {
		if (list.includes(p)) return true;
	}
	return false;
}

// Parses a list of packets shown by apt-get under a certain heading
function parseAptPackageList(stdout: string, heading: string) {
	return stdout
		.split(heading)[1]
		?.split(/\n\w+/)[0]
		?.replace(/[\n ]+/g, " ")
		?.trim();
}

function parseAptUpgradedPackages(stdout: string) {
	return parseAptPackageList(
		stdout,
		"The following packages will be upgraded:\n",
	);
}

function parseAptUpgradeSummary(stdout: string) {
	const upgradeCount = parseUpgradePackageCount(stdout) ?? 0;
	let downloadSize: string | undefined;
	let ceralivePackages = false;
	if (upgradeCount > 0) {
		downloadSize = parseUpgradeDownloadSize(stdout);

		const packageList = parseAptUpgradedPackages(stdout);
		if (packageList && packageListIncludes(packageList, ceralivePackageList)) {
			ceralivePackages = true;
		}
	}

	return { upgradeCount, downloadSize, ceralivePackages };
}

async function getSoftwareUpdateSize() {
	if (getIsStreaming() || isUpdating() || aptGetUpdating) return "busy";

	// First see if any packages can be upgraded by dist-upgrade
	let upgrade = await execPNR("apt-get dist-upgrade --assume-no");
	let res = parseAptUpgradeSummary(upgrade.stdout);

	// Otherwise, check if any packages have been held back (e.g. by dependencies changing)
	if (res.upgradeCount === 0) {
		aptHeldBackPackages = parseAptPackageList(
			upgrade.stdout,
			"The following packages have been kept back:\n",
		);
		if (aptHeldBackPackages) {
			upgrade = await execPNR(
				`apt-get install --assume-no ${aptHeldBackPackages}`,
			);
			res = parseAptUpgradeSummary(upgrade.stdout);
		}
	} else {
		// Reset aptHeldBackPackages if some upgrades became available via dist-upgrade
		aptHeldBackPackages = undefined;
	}

	if (res.ceralivePackages) {
		notificationBroadcast(
			"ceralive_update",
			"warning",
			"A CERALIVE update is available. Scroll down to the System menu to install it.",
			0,
			true,
			false,
		);
	}

	availableUpdates = {
		package_count: res.upgradeCount,
		download_size: res.downloadSize,
	};
	broadcastMsg("status", { available_updates: availableUpdates });

	return null;
}

type SoftwareUpdateError = ExecException | "busy" | true | null;

function checkForSoftwareUpdates(
	callback: (err: SoftwareUpdateError, aptGetUpdateFailures: number) => unknown,
) {
	if (getIsStreaming() || isUpdating() || aptGetUpdating) return;

	aptGetUpdating = true;
	exec("apt-get update --allow-releaseinfo-change", (err, stdout, stderr) => {
		let errOrStderr: SoftwareUpdateError = err;

		aptGetUpdating = false;

		if (stderr.length) {
			errOrStderr = true;
			aptGetUpdateFailures++;
			queueUpdateGw();
		} else {
			aptGetUpdateFailures = 0;
		}

		logger.info(
			`apt-get update: ${errOrStderr === null ? "success" : "error"}`,
		);
		if (stdout) logger.info(stdout);
		if (stderr) logger.error(stderr);

		if (callback) callback(errOrStderr, aptGetUpdateFailures);
	});
}

let nextCheckForSoftwareUpdates = getms();
let nextCheckForSoftwareUpdatesTimer: ReturnType<typeof setTimeout> | undefined;

export function periodicCheckForSoftwareUpdates() {
	if (nextCheckForSoftwareUpdatesTimer) {
		clearTimeout(nextCheckForSoftwareUpdatesTimer);
		nextCheckForSoftwareUpdatesTimer = undefined;
	}

	const ms = getms();
	if (ms < nextCheckForSoftwareUpdates) {
		nextCheckForSoftwareUpdatesTimer = setTimeout(
			periodicCheckForSoftwareUpdates,
			nextCheckForSoftwareUpdates - ms,
		);
		return;
	}

	checkForSoftwareUpdates(async (err_, failures) => {
		const err = err_ === null ? await getSoftwareUpdateSize() : err_;

		// one hour delay after a succesful check
		let delay = oneHour;
		// otherwise, increasing delay depending on the number of failures
		if (err !== null) {
			// try after 10s for the first ~2 minutes
			if (failures < 12) {
				delay = 10;
				// back off to a minute delay
			} else {
				delay = oneMinute;
			}
		}
		nextCheckForSoftwareUpdates = getms() + delay;
		nextCheckForSoftwareUpdatesTimer = setTimeout(
			periodicCheckForSoftwareUpdates,
			delay,
		);
	});
}

export function startSoftwareUpdate() {
	if (!setup.apt_update_enabled || getIsStreaming() || isUpdating()) return;

	// if an apt-get update is already in progress, retry later
	if (aptGetUpdating) {
		setTimeout(startSoftwareUpdate, 3 * 1000);
		return;
	}

	checkForSoftwareUpdates((err) => {
		if (err === null) {
			doSoftwareUpdate();
		} else if (softUpdateStatus) {
			softUpdateStatus.result =
				"Failed to fetch the updated package list; aborting the update.";
			broadcastMsg("status", { updating: softUpdateStatus });
			softUpdateStatus = null;
		}
	});

	softUpdateStatus = { downloading: 0, unpacking: 0, setting_up: 0, total: 0 };
	broadcastMsg("status", { updating: softUpdateStatus });
}

function doSoftwareUpdate() {
	if (!setup.apt_update_enabled || getIsStreaming()) return;

	let rebootAfterUpgrade = false;
	let aptLog = "";
	let aptErr = "";

	let args =
		"-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold ";
	if (aptHeldBackPackages) {
		args += `install ${aptHeldBackPackages}`;
	} else {
		args += "dist-upgrade";
	}
	const aptUpgrade = spawn("apt-get", args.split(" "));

	aptUpgrade.stdout.on("data", (buf) => {
		let sendUpdate = false;

		const data = buf.toString("utf8");
		aptLog += data;

		if (!softUpdateStatus) return;

		if (softUpdateStatus.total === 0) {
			const count = parseUpgradePackageCount(data);
			if (count !== undefined) {
				softUpdateStatus.total = count;
				sendUpdate = true;

				const packageList = parseAptUpgradedPackages(aptLog);
				if (
					packageList &&
					packageListIncludes(packageList, rebootPackageList)
				) {
					rebootAfterUpgrade = true;
				}
			}
		}

		if (softUpdateStatus.downloading !== softUpdateStatus.total) {
			const getMatch = data.match(/Get:(\d+)/);
			if (getMatch) {
				const i = Number.parseInt(getMatch[1], 10);
				if (i > softUpdateStatus.downloading) {
					softUpdateStatus.downloading = Math.min(i, softUpdateStatus.total);
					sendUpdate = true;
				}
			}
		}

		const unpacking = data.match(/Unpacking /g);
		if (unpacking) {
			softUpdateStatus.downloading = softUpdateStatus.total;
			softUpdateStatus.unpacking += unpacking.length;
			softUpdateStatus.unpacking = Math.min(
				softUpdateStatus.unpacking,
				softUpdateStatus.total,
			);
			sendUpdate = true;
		}

		const setting_up = data.match(/Setting up /g);
		if (setting_up) {
			softUpdateStatus.setting_up += setting_up.length;
			softUpdateStatus.setting_up = Math.min(
				softUpdateStatus.setting_up,
				softUpdateStatus.total,
			);
			sendUpdate = true;
		}

		if (sendUpdate) {
			broadcastMsg("status", { updating: softUpdateStatus });
		}
	});

	aptUpgrade.stderr.on("data", (data) => {
		aptErr += data;
	});

	aptUpgrade.on("close", (code) => {
		if (softUpdateStatus) {
			softUpdateStatus.result = code === 0 ? code : aptErr;
			broadcastMsg("status", { updating: softUpdateStatus });
			softUpdateStatus = null;
		}

		if (aptLog) logger.info(aptLog);
		if (aptErr) logger.error(aptErr);

		if (code === 0) {
			if (rebootAfterUpgrade) {
				spawnSync("reboot");
			} else {
				process.exit(0);
			}
		}
	});
}
