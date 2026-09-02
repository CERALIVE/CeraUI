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
 * Bluetooth foundation — the names, paths and budgets the rest of the module
 * keys on. Nothing here reads a device; it is data plus one predicate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE UNIT NAME IS `bluealsa.service`, AND `bluealsad` IS THE BINARY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Debian's `bluez-alsa-utils` ships the daemon as `/usr/bin/bluealsad` (it was
 * renamed from `bluealsa` upstream in bluez-alsa 4.x) but keeps the systemd unit
 * called `bluealsa.service`. The two names are one character apart and the wrong
 * one fails SILENTLY in the direction that matters: `systemctl enable --now
 * bluealsad.service` exits non-zero with "Unit bluealsad.service not found", the
 * apply path logs it, the operator's preference is still persisted, and the
 * device comes up with Bluetooth on and no ALSA PCM behind it — i.e. a
 * microphone that pairs, connects, and can never be opened.
 *
 * {@link BLUEALSA_UNIT} is therefore pinned by a test asserting the exact
 * string. Do NOT "fix" it to match the binary name.
 */

/** The BlueZ daemon unit. Enabled/disabled with the operator's BT preference. */
export const BLUETOOTH_UNIT = "bluetooth.service";

/**
 * The BlueALSA daemon unit — the EXACT Debian unit name.
 *
 * `bluealsad` is the BINARY (`/usr/bin/bluealsad`), NOT the unit. See the module
 * header; pinned by `bluetooth-services.test.ts`.
 */
export const BLUEALSA_UNIT = "bluealsa.service";

/** Both units the operator's Bluetooth preference governs, in apply order. */
export const BLUETOOTH_UNITS: readonly string[] = [
	BLUETOOTH_UNIT,
	BLUEALSA_UNIT,
];

/** Candidate BlueALSA daemon binaries, newest upstream name first. */
export const BLUEALSA_BINARIES: readonly string[] = [
	"/usr/bin/bluealsad",
	"/usr/bin/bluealsa",
];

export const BLUEALSA_PACKAGE_MARKER =
	"/var/lib/dpkg/info/bluez-alsa-utils.list";

export const PIPEWIRE_BLUETOOTH_PACKAGE_MARKER =
	"/var/lib/dpkg/info/libspa-0.2-bluetooth.list";

/** Where the BlueALSA argument drop-in is written. */
export const BLUEALSA_DROPIN_DIR = "/etc/systemd/system/bluealsa.service.d";

/** The drop-in file itself — namespaced so a distro drop-in is never clobbered. */
export const BLUEALSA_DROPIN_PATH = `${BLUEALSA_DROPIN_DIR}/10-ceralive-hfp-ag.conf`;

/**
 * BlueALSA profiles CeraLive needs.
 *
 * `hfp-ag` is the load-bearing one: it makes the board the Hands-Free Audio
 * Gateway, which is what gives a headset's MICROPHONE an ALSA capture PCM
 * (`PROFILE=sco`). `a2dp-source` covers the A2DP-source-only devices that stream
 * audio to us without any SCO leg at all.
 */
export const BLUEALSA_PROFILES: readonly string[] = [
	"a2dp-source",
	"a2dp-sink",
	"hfp-ag",
];

/** The wideband-speech codec appended ONLY when the build probes as supporting it. */
export const BLUEALSA_MSBC_CODEC = "msbc";

// ─── BlueZ D-Bus vocabulary ───────────────────────────────────────────────────

export const BLUEZ_SERVICE = "org.bluez";
export const BLUEZ_ROOT_PATH = "/";
export const BLUEZ_MANAGER_PATH = "/org/bluez";

export const ADAPTER_IFACE = "org.bluez.Adapter1";
export const DEVICE_IFACE = "org.bluez.Device1";
export const BATTERY_IFACE = "org.bluez.Battery1";
export const AGENT_MANAGER_IFACE = "org.bluez.AgentManager1";
export const AGENT_IFACE = "org.bluez.Agent1";

export const OBJECT_MANAGER_IFACE = "org.freedesktop.DBus.ObjectManager";
export const PROPERTIES_IFACE = "org.freedesktop.DBus.Properties";

/** The object path CeraUI exports its pairing agent at. */
export const CERALIVE_AGENT_PATH = "/tv/ceralive/bluetooth/agent";

/**
 * The only agent capability CeraLive can honestly claim: the board has no
 * keypad and no display an operator is looking at during a pairing, so it can
 * neither enter nor confirm a passkey.
 */
export const AGENT_CAPABILITY_NO_IO = "NoInputNoOutput";

// ─── Budgets (S1: every call is bounded) ──────────────────────────────────────

/** Wall-clock budget for a `systemctl` one-shot on this path. */
export const SYSTEMCTL_TIMEOUT_MS = 15_000;

/** Wall-clock budget for the `--help` capability probe of the BlueALSA daemon. */
export const BLUEALSA_PROBE_TIMEOUT_MS = 5_000;

/** Budget for an ordinary BlueZ property read / short method call. */
export const DBUS_CALL_TIMEOUT_MS = 10_000;

/**
 * Budget for `Device1.Pair`.
 *
 * BlueZ's own pairing timeout is 60 s (`bluetoothd` `-P`/`PairableTimeout`
 * neighbourhood), so a shorter cap here would report a pairing that is still
 * legitimately in progress as failed. 65 s leaves BlueZ room to answer first.
 */
export const DBUS_PAIR_TIMEOUT_MS = 65_000;

/** Budget for `Device1.Connect` — used by the operator path AND boot reconnect. */
export const DBUS_CONNECT_TIMEOUT_MS = 20_000;

/** How long a discovery runs before the module stops it on its own (bounded). */
export const DISCOVERY_WINDOW_MS = 30_000;

/** The system bus address, matching the cellular observation path's default. */
export const SYSTEM_BUS_ADDRESS = "unix:path=/var/run/dbus/system_bus_socket";

export function resolveSystemBusAddress(
	env: Record<string, string | undefined> = process.env,
): string {
	const configured = env.DBUS_SYSTEM_BUS_ADDRESS?.trim();
	return configured !== undefined && configured.length > 0
		? configured
		: SYSTEM_BUS_ADDRESS;
}
