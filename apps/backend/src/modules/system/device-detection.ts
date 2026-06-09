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
 * Real-device detection (T4 — gating prerequisite for the kiosk RPC, T13).
 *
 * Answers a single fail-safe question: are we running on a real RK3588 board
 * that physically owns a display, or in dev/CI/an emulated host where touching
 * the host OS (cage/Chromium/systemd) would be wrong? The default is ALWAYS
 * false — we only return true when we positively recognise the hardware (or an
 * explicit `CERALIVE_DEVICE_TYPE=real` override). Detection is read-only here;
 * gating the kiosk handlers on this signal is deferred to T13.
 *
 * The hardware probe (`/proc/device-tree/model`) is injected through
 * {@link DeviceDetectionDeps} — mirroring `defaultKioskDeps` in kiosk.ts — so
 * the classifier is unit-testable without a board and never shells out or reads
 * a host file during tests.
 */

import { isDevelopment } from "../../mocks/mock-config.ts";

/** Device-tree path Rockchip boards expose their model string on. */
const DEVICE_TREE_MODEL = "/proc/device-tree/model";

/**
 * Substrings that positively identify an RK3588 board. On a real Rockchip
 * board `/proc/device-tree/model` reads e.g. "Rockchip RK3588 ...".
 */
const REAL_DEVICE_MARKERS = ["Rockchip", "RK3588"] as const;

/**
 * Injectable detection surface. The default talks to the real OS (env var +
 * `Bun.file` device-tree read + the shared `isDevelopment` flag). Tests inject
 * deterministic stand-ins so the five detection branches are exercised without
 * hardware. Mirrors `KioskDeps`/`defaultKioskDeps` in kiosk.ts.
 */
export type DeviceDetectionDeps = {
	/** Explicit `CERALIVE_DEVICE_TYPE` override ("real" | "emulated" | unset). */
	getDeviceTypeOverride: () => string | undefined;
	/** Whether the backend is running in dev/mock mode. */
	isDevelopment: () => boolean;
	/**
	 * Read the device-tree model string. MAY reject (file absent/unreadable);
	 * {@link isRealDevice} swallows the rejection and resolves false.
	 */
	readDeviceTreeModel: () => Promise<string>;
};

export const defaultDeviceDetectionDeps: DeviceDetectionDeps = {
	getDeviceTypeOverride: () => process.env.CERALIVE_DEVICE_TYPE,
	isDevelopment,
	readDeviceTreeModel: () => Bun.file(DEVICE_TREE_MODEL).text(),
};

/**
 * Fail-safe real-device classifier. Resolution order:
 *
 *  1. `CERALIVE_DEVICE_TYPE` override — "real" → true, "emulated" → false.
 *  2. Dev/mock mode → false (never drive the host OS from a dev box).
 *  3. `/proc/device-tree/model` names a Rockchip / RK3588 board → true.
 *  4. The device-tree read fails (file absent/unreadable) → false.
 *  5. Otherwise → false.
 *
 * Any error from the injected probe is swallowed here — file-read failures must
 * never propagate; an unrecognised or unreadable host is treated as "not a real
 * device" so we err on the side of NOT touching the host OS.
 */
export async function isRealDevice(
	deps: DeviceDetectionDeps = defaultDeviceDetectionDeps,
): Promise<boolean> {
	const override = deps.getDeviceTypeOverride();
	if (override === "real") return true;
	if (override === "emulated") return false;

	if (deps.isDevelopment()) return false;

	try {
		const model = await deps.readDeviceTreeModel();
		return REAL_DEVICE_MARKERS.some((marker) => model.includes(marker));
	} catch {
		return false;
	}
}
