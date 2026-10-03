/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Boot resume of a persisted `downloading` phase, replayed from the opi r5x
 * mains-cut drill (X1, 2026-09-30, `46.5-power/`): the cut hit dpkg while the
 * persisted phase still said `downloading`, the board rebooted with no install
 * unit, discovery reported the half-installed package as available again, and
 * the orchestrator sat in `downloading` refusing every check/install.
 *
 * Round 17 narrowed the recovery: only a probe that PROVED the unit gone drops
 * the attempt (to `idle`, check due, plan left on disk); a skipped or failed probe
 * keeps `downloading` and is re-asked on later ticks.
 */

import type { UpdateState } from "@ceraui/rpc/schemas";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../../modules/system/update-orchestrator/types.ts";

export const DRILL_ENTERED_AT = 1790810755027;

export const DRILL_PENDING = [
	{ name: "rsync", version: "3.5.0+ds1-0+deb13u1" },
	{ name: "libcpupower1", version: "6.12.111-1" },
	{ name: "libcups2t64", version: "2.4.10-3+deb13u2" },
	{ name: "libxml2", version: "2.12.7+dfsg+really2.9.14-2.1+deb13u3" },
	{ name: "libxslt1.1", version: "1.1.35-1.2+deb13u3" },
	{ name: "linux-cpupower", version: "6.12.111-1" },
];

export const DRILL_WIRE_AFTER_BOOT: UpdateState = {
	kind: "available",
	identity: { version: "10abce4f001d", packages: ["linux-cpupower"] },
	package_count: 1,
	actionable_count: 1,
	packages: [
		{
			name: "linux-cpupower",
			version: "6.12.111-1",
			layer: "app",
			actionable: true,
		},
	],
};

export const persistedDownloading: OrchestratorState = {
	...initialOrchestratorState(1),
	phase: "downloading",
	enteredAt: DRILL_ENTERED_AT,
	progress: { percent: 0, etaSeconds: 0 },
};

export const NOTHING_ACTIONABLE: UpdateState = {
	kind: "available",
	identity: {
		version: "0b1c2d3e4f50",
		packages: ["gstreamer1.0-rockchip-ceralive"],
	},
	package_count: 1,
	actionable_count: 0,
	packages: [
		{
			name: "gstreamer1.0-rockchip-ceralive",
			version: "1.14.4+ceralive.8",
			layer: "platform",
			actionable: false,
		},
	],
};

export const CPUPOWER_PLAN = [
	{ name: "linux-cpupower", version: "6.12.111-1" },
];

export const DOWNLOADING_WIRE: UpdateState = {
	kind: "downloading",
	progress: { total: 1, downloading: 1, unpacking: 0, setting_up: 0 },
	identity: DRILL_WIRE_AFTER_BOOT.identity,
};

export const INSTALLING_WIRE: UpdateState = {
	kind: "installing",
	progress: { total: 1, downloading: 0, unpacking: 1, setting_up: 0 },
	identity: DRILL_WIRE_AFTER_BOOT.identity,
};
