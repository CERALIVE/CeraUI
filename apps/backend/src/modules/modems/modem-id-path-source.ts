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

/**
 * Resolving `ifname → udev ID_PATH`, the input every `stable_key` is minted from.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE: the map used to be built by walking
 * `@ceralive/modem-control`'s `createUsbEnumerator().enumerate()` and reading
 * `device.ifname` off each `UsbDeviceSnapshot`. That field is declared on the
 * type and **the enumerator never populates it** — `parseUdevDatabase` keeps only
 * records whose `DEVTYPE` is `usb_device`, and a `usb_device` record does not
 * carry `INTERFACE`. Board-measured on `ceralive2` (2026-08-18):
 *
 *     udevadm info --export-db | (records with DEVTYPE=usb_device)          -> 24
 *     ...of those, records also carrying E: INTERFACE=                      ->  0
 *
 * So the map was ALWAYS EMPTY on real hardware, `getModemIdPath()` always
 * answered `undefined`, and every modem therefore resolved to no `stable_key` —
 * which the mutation contract fails closed on. The operator-visible consequence
 * was that EVERY modem mutation (a config save, a network scan, a SIM unlock)
 * refused with `identity_unresolved`, on a board whose modems all publish a
 * perfectly good `ID_PATH`.
 *
 * The netdev is a SEPARATE udev record from its USB device — a child, under the
 * `net` subsystem — and it is the record that carries both `INTERFACE` and
 * `ID_PATH`. Reading THAT is the whole fix. The interface-level `ID_PATH`
 * (`…-usb-0:1.4.4:1.4`) is reduced to its `usb_device` parent by the shared
 * `deriveModemStableKey`, so it mints the SAME key as ModemManager's sysfs
 * `Modem.Physdev` for the same socket — the two encodings were already
 * reconciled at the derivation and nothing here re-does that.
 *
 * NEVER FABRICATED: a netdev whose record carries no `ID_PATH` is OMITTED rather
 * than keyed on its name. The bench's duplicate-MAC HiLink twin is exactly that
 * device — its rename collides, udev commits no further properties, and it has
 * no `ID_PATH` at all — so it keeps the honest "unresolved" answer the identity
 * contract permits.
 */

import { logger } from "../../helpers/logger.ts";
import { spawnWithTimeout } from "../../helpers/spawn-policy.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";

/**
 * `udevadm info --export-db` is a local database dump, but it runs on the boot
 * discovery path and on every presence edge, so it is bounded like every other
 * read-only probe rather than left able to hang the modem loop.
 */
const UDEV_EXPORT_TIMEOUT_MS = 10_000;

/** A netdev record must publish both of these to be usable as an identity anchor. */
const INTERFACE_KEY = "INTERFACE";
const ID_PATH_KEY = "ID_PATH";
const SUBSYSTEM_KEY = "SUBSYSTEM";
const NET_SUBSYSTEM = "net";

/**
 * Parse `udevadm info --export-db` output into `ifname → ID_PATH`.
 *
 * Pure and exported so the production parse is provable against verbatim board
 * output with no udev on the host. Records are blank-line separated; only `E:`
 * lines are read, so the `P:`/`N:`/`S:`/`L:` lines a future udev adds are inert.
 */
export function parseNetIdPaths(exportDb: string): ReadonlyMap<string, string> {
	const resolved = new Map<string, string>();
	for (const block of exportDb.split("\n\n")) {
		const env = new Map<string, string>();
		for (const line of block.split("\n")) {
			if (!line.startsWith("E: ")) continue;
			const rest = line.slice(3);
			const eq = rest.indexOf("=");
			if (eq > 0) env.set(rest.slice(0, eq), rest.slice(eq + 1));
		}
		if (env.get(SUBSYSTEM_KEY) !== NET_SUBSYSTEM) continue;
		const ifname = env.get(INTERFACE_KEY)?.trim();
		const idPath = env.get(ID_PATH_KEY)?.trim();
		// Both or neither: an ifname with no ID_PATH cannot anchor an identity,
		// and keying it on the name is the one thing this map must never do.
		if (!ifname || !idPath) continue;
		resolved.set(ifname, idPath);
	}
	return resolved;
}

async function readUdevExportDb(): Promise<string> {
	const result = await spawnWithTimeout(["udevadm", "info", "--export-db"], {
		timeoutMs: UDEV_EXPORT_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`udevadm info --export-db exited ${result.exitCode}: ${result.stderr.trim()}`,
		);
	}
	return result.stdout;
}

/**
 * The production reader: ONE `udevadm` pass, parsed for net records.
 *
 * An empty answer on a real device is LOUD. It is indistinguishable at every
 * later call site from "this board has no modems", and it is precisely the shape
 * the retired enumerator bug took — silently, for the life of the process.
 */
export async function readModemIdPaths(): Promise<ReadonlyMap<string, string>> {
	if (shouldUseMocks()) {
		const { getMockModemIdPaths } = await import(
			"../../mocks/providers/cellular.ts"
		);
		return getMockModemIdPaths();
	}
	const resolved = parseNetIdPaths(await readUdevExportDb());
	if (resolved.size === 0) {
		logger.warn(
			"udev named no network interface with an ID_PATH; every modem will report an unresolved identity and refuse mutations",
		);
	}
	return resolved;
}
