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
 * Answers a single fail-safe question: are we running on a shipping CeraLive
 * device, or in dev/CI/an emulated host where touching the host OS
 * (cage/Chromium/systemd) would be wrong? The default is ALWAYS false — we only
 * return true when we positively recognise RK3588 or x86 mini-PC hardware (or an
 * explicit `CERALIVE_DEVICE_TYPE=real` override). Jetson remains deliberately
 * deferred: no Jetson marker is recognised here.
 *
 * The hardware probes are injected through
 * {@link DeviceDetectionDeps} — mirroring `defaultKioskDeps` in kiosk.ts — so
 * the classifier is unit-testable without a board and never shells out or reads
 * a host file during tests.
 */

import { isDevelopment } from "../../mocks/mock-config.ts";

/** Device-tree path Rockchip boards expose their model string on. */
const DEVICE_TREE_MODEL = "/proc/device-tree/model";
/**
 * Device-tree path exposing the board's `compatible` list (NUL-separated on
 * disk). This is the RELIABLE RK3588 marker: it always carries the SoC
 * compatible string (e.g. "radxa,rock-5b-plus\0rockchip,rk3588"), even on
 * boards whose `model` string never names the SoC. The Radxa ROCK 5B+ reads
 * "Radxa ROCK 5B+" with no "RK3588" substring, so the model check alone
 * wrongly classifies a real board as emulated — the compatible check fixes it.
 */
const DEVICE_TREE_COMPATIBLE = "/proc/device-tree/compatible";
const CERALIVE_RELEASE_FILE = "/etc/ceralive/release";
const DMI_PRODUCT_NAME = "/sys/class/dmi/id/product_name";
const DMI_BOARD_NAME = "/sys/class/dmi/id/board_name";

/**
 * Substring that positively identifies an RK3588 board. Matched
 * case-insensitively against BOTH `/proc/device-tree/compatible` (lowercase
 * "rockchip,rk3588") and `/proc/device-tree/model` (uppercase "RK3588" on the
 * boards whose model string names the SoC, e.g. Orange Pi 5+).
 */
const RK3588_DEVICE_MARKER = "RK3588";
const X86_MINIPC_DMI_MARKERS = ["N100", "N200", "Mini PC", "MINIPC"] as const;
const CERALIVE_RELEASE_ID_RE = /^ID="?ceralive"?$/m;

/**
 * Injectable detection surface. The default talks to the real OS (env var +
 * `Bun.file` hardware reads + the shared `isDevelopment` flag). Tests inject
 * deterministic stand-ins so every detection branch is exercised without
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
	/**
	 * Read the device-tree `compatible` list (NUL-separated on disk). The
	 * reliable RK3588 marker. MAY reject (file absent/unreadable);
	 * {@link isRealDevice} swallows the rejection and resolves false.
	 */
	readDeviceTreeCompatible: () => Promise<string>;
	readCeraliveRelease: () => Promise<string>;
	readDmiProductName: () => Promise<string>;
	readDmiBoardName: () => Promise<string>;
};

export const defaultDeviceDetectionDeps: DeviceDetectionDeps = {
	getDeviceTypeOverride: () => process.env.CERALIVE_DEVICE_TYPE,
	isDevelopment,
	readDeviceTreeModel: () => Bun.file(DEVICE_TREE_MODEL).text(),
	readDeviceTreeCompatible: () => Bun.file(DEVICE_TREE_COMPATIBLE).text(),
	readCeraliveRelease: () => Bun.file(CERALIVE_RELEASE_FILE).text(),
	readDmiProductName: () => Bun.file(DMI_PRODUCT_NAME).text(),
	readDmiBoardName: () => Bun.file(DMI_BOARD_NAME).text(),
};

async function readOptional(probe: () => Promise<string>): Promise<string> {
	try {
		return await probe();
	} catch {
		return "";
	}
}

function hasRk3588Marker(identity: string): boolean {
	return identity.toLowerCase().includes(RK3588_DEVICE_MARKER.toLowerCase());
}

function hasCeraliveImageIdentity(release: string): boolean {
	return CERALIVE_RELEASE_ID_RE.test(release);
}

function hasX86MiniPcDmiMarker(dmi: string): boolean {
	return X86_MINIPC_DMI_MARKERS.some((marker) => dmi.includes(marker));
}

/**
 * Fail-safe real-device classifier. Resolution order:
 *
 *  1. `CERALIVE_DEVICE_TYPE` override — "real" → true, "emulated" → false.
 *  2. Dev/mock mode → false (never drive the host OS from a dev box).
 *  3. `/proc/device-tree/compatible` OR `/proc/device-tree/model` names an
 *     RK3588 board → true. The `compatible` list is the reliable marker (it
 *     always carries "rockchip,rk3588"); `model` is a belt-and-suspenders
 *     fallback for boards whose model string itself names the SoC.
 *  4. CeraLive image identity + x86 mini-PC DMI marker → true.
 *  5. Otherwise → false.
 *
 * Any error from injected probes is swallowed here — file-read failures must
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

	// `compatible` is the reliable RK3588 marker (always carries
	// "rockchip,rk3588"); `model` is a fallback for boards whose model string
	// itself names the SoC (e.g. Orange Pi 5+). Either match is a real device.
	if (hasRk3588Marker(await readOptional(deps.readDeviceTreeCompatible))) {
		return true;
	}
	if (hasRk3588Marker(await readOptional(deps.readDeviceTreeModel))) {
		return true;
	}

	if (!hasCeraliveImageIdentity(await readOptional(deps.readCeraliveRelease))) {
		return false;
	}

	const dmiIdentity = [
		await readOptional(deps.readDmiProductName),
		await readOptional(deps.readDmiBoardName),
	].join("\n");
	return hasX86MiniPcDmiMarker(dmiIdentity);
}

/**
 * Test helper: deterministically override `isRealDevice()` for a single test.
 *
 * Sets `CERALIVE_DEVICE_TYPE` env to the specified value before calling `fn`,
 * then restores the original env value after `fn` completes (even on error).
 * This is the canonical way to flip the device-detection gate in unit tests
 * for the dozen gated subsystems (add-ons, kiosk, SIM auto-unlock).
 *
 * @example
 * ```typescript
 * await withDeviceType("real", async () => {
 *   const isReal = await isRealDevice();
 *   expect(isReal).toBe(true);
 * });
 * ```
 */
export async function withDeviceType(
	type: "real" | "emulated",
	fn: () => void | Promise<void>,
): Promise<void> {
	const original = process.env.CERALIVE_DEVICE_TYPE;
	try {
		process.env.CERALIVE_DEVICE_TYPE = type;
		await fn();
	} finally {
		if (original === undefined) {
			delete process.env.CERALIVE_DEVICE_TYPE;
		} else {
			process.env.CERALIVE_DEVICE_TYPE = original;
		}
	}
}
