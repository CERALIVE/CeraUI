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

/*
 * Bluetooth microphones as selectable audio sources.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PRESENCE ORACLE FOLLOWS THE ENGINE AUDIO BACKEND; NEVER BlueZ `Connected`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `org.bluez.Device1.Connected` says a link exists. It does NOT say the board
 * can open a microphone: a headset connects over A2DP alone, a SCO transport is
 * negotiated separately, and `bluealsad` may not be running at all. With
 * `pipewire-capture`, a matching engine audio node is the oracle: its
 * `device_address` is matched to the registry MAC and its `input_id` becomes
 * the capture target. The BlueALSA bus is not consulted on that path. Without
 * that feature, a row is published only when `org.bluealsa` exports a capture
 * PCM object for it — exactly the object `alsasrc device=bluealsa:...` opens.
 * The BlueZ registry contributes the operator-facing name and `scoCapable`
 * UUID verdict, which keeps an A2DP-source-only phone from being offered a
 * `PROFILE=sco` row whose every open would fail.
 *
 * The same asymmetry governs FAILURE: the registry's connection state ENRICHES
 * the probe's message so an operator is told which device is missing and whether
 * BlueZ still sees it, but it can never SATISFY the probe.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LEGACY BLUEALSA AFFORDANCE IS GATED ON `audio-pcm-spec`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * On the legacy arm, a BlueALSA address is an OPAQUE plugin PCM, not a card.
 * An engine that predates todo 4 resolves `audio.device` through its card
 * registry, so it would answer a
 * `bluealsa:` string with a card lookup that finds nothing — a start that fails
 * at the leg, seconds after the operator committed. `features` is cerastream's
 * own fail-closed negotiation contract, so the row is rendered DISABLED with the
 * `engine_update_required` reason instead: listed (the hardware is genuinely
 * there and the operator paired it deliberately), never selectable, never a
 * runtime surprise.
 */

import type { DbusValue, DbusVariant } from "@ceralive/modem-control/transport";
import { isVariant } from "@ceralive/modem-control/transport";
import type { AudioSourceQuality } from "@ceraui/rpc/schemas";
import { AUDIO_SOURCE_UNAVAILABLE_REASONS } from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import type { EngineAudioDevice } from "./audio-naming.ts";
import { getLastCapabilities } from "./capabilities.ts";
import { getEngineAudioDevices } from "./sources.ts";

export const BLUEALSA_SERVICE = "org.bluealsa";
export const BLUEALSA_ROOT_PATH = "/org/bluealsa";
export const BLUEALSA_PCM_INTERFACE = "org.bluealsa.PCM1";
const OBJECT_MANAGER_INTERFACE = "org.freedesktop.DBus.ObjectManager";

/** The engine feature token that authorizes an opaque (non-card) ALSA PCM spec. */
export const AUDIO_PCM_SPEC_FEATURE = "audio-pcm-spec";

export const PIPEWIRE_CAPTURE_FEATURE = "pipewire-capture";

/** Every `config.asrc` value naming a Bluetooth microphone starts with this. */
export const BLUETOOTH_AUDIO_ID_PREFIX = "bt:";

const BLUEALSA_CALL_TIMEOUT_MS = 4_000;

/** `dev_AA_BB_CC_DD_EE_FF` anywhere in a BlueZ or BlueALSA object path. */
const DEVICE_PATH_ADDRESS_RE =
	/(?:^|\/)dev_([0-9A-Fa-f]{2}(?:_[0-9A-Fa-f]{2}){5})(?:\/|$)/;

/**
 * BlueALSA transport tokens that carry a SCO microphone leg.
 *
 * bluez-alsa 3.x names them `SCO-AG` / `SCO-HF`; 4.x renamed them to the profile
 * (`HFP-AG` / `HFP-HF` / `HSP-AG` / `HSP-HS`). Both shipped in Debian within this
 * project's support window and the image does not pin which one is installed, so
 * BOTH vocabularies are accepted — the alternative is a mic that silently never
 * appears on whichever build the board happens to carry.
 */
const SCO_TRANSPORT_TOKENS: readonly string[] = ["SCO", "HFP", "HSP"];

export interface BluealsaCapturePcm {
	readonly path: string;
	/** Colon-separated upper-case MAC, i.e. the form `DEV=` takes. */
	readonly address: string;
	readonly codec: string | undefined;
	readonly sampleRateHz: number | undefined;
	readonly channels: number | undefined;
}

/** The BlueZ registry facts a source row needs; a projection, never the row itself. */
export interface BluetoothAudioDevice {
	readonly address: string | undefined;
	readonly alias: string | undefined;
	readonly name: string | undefined;
	readonly connected: boolean;
	readonly scoCapable: boolean;
}

export interface BluetoothAudioSource {
	readonly id: string;
	readonly address: string;
	readonly displayName: string;
	/** AudioConfig.device: BlueALSA PCM on legacy, PipeWire node.name on migration. */
	readonly pcmSpec: string;
	readonly quality: AudioSourceQuality | undefined;
	readonly unavailableReason:
		| typeof AUDIO_SOURCE_UNAVAILABLE_REASONS.ENGINE_UPDATE_REQUIRED
		| undefined;
}

/** True when `id` names a Bluetooth microphone rather than an ALSA card. */
export function isBluetoothAudioSourceId(id: string): boolean {
	return id.startsWith(BLUETOOTH_AUDIO_ID_PREFIX);
}

/**
 * The stable, address-derived source id.
 *
 * Underscored rather than colon-separated because `config.asrc` values travel
 * through log lines, file names and i18n interpolation, and a colon-heavy token
 * is indistinguishable from an ALSA selector at a glance. The address is what
 * makes it stable: it survives a rename, a re-pair and a controller restart,
 * none of which a BlueZ object path does.
 */
export function bluetoothAudioSourceId(address: string): string {
	return `${BLUETOOTH_AUDIO_ID_PREFIX}${address.toUpperCase().replaceAll(":", "_")}`;
}

/** The verbatim `alsasrc device=` string for this microphone's SCO capture leg. */
export function bluealsaScoPcmSpec(address: string): string {
	return `bluealsa:DEV=${address.toUpperCase()},PROFILE=sco`;
}

function normalizeAddress(raw: string): string {
	return raw.toUpperCase().replaceAll("_", ":");
}

/** The MAC a BlueZ/BlueALSA object path encodes, or `undefined` when it encodes none. */
export function addressFromObjectPath(path: string): string | undefined {
	const matched = DEVICE_PATH_ADDRESS_RE.exec(path);
	const captured = matched?.[1];
	return captured === undefined ? undefined : normalizeAddress(captured);
}

function variantValue(
	props: ReadonlyMap<string, DbusVariant>,
	key: string,
): DbusValue | undefined {
	return props.get(key)?.value;
}

function asString(value: DbusValue | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInteger(value: DbusValue | undefined): number | undefined {
	const numeric = typeof value === "bigint" ? Number(value) : value;
	if (typeof numeric !== "number") return undefined;
	if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
	return Math.trunc(numeric);
}

function decodeProps(value: DbusValue | undefined): Map<string, DbusVariant> {
	const props = new Map<string, DbusVariant>();
	if (!Array.isArray(value)) return props;
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const [name, variant] = entry;
		if (typeof name !== "string") continue;
		if (variant !== undefined && isVariant(variant)) props.set(name, variant);
	}
	return props;
}

function isScoCapturePcm(
	props: ReadonlyMap<string, DbusVariant>,
	path: string,
): boolean {
	if (asString(variantValue(props, "Mode"))?.toLowerCase() !== "source")
		return false;
	const transport = asString(variantValue(props, "Transport"))?.toUpperCase();
	if (transport !== undefined) {
		return SCO_TRANSPORT_TOKENS.some((token) => transport.includes(token));
	}
	// A build that publishes no `Transport` still encodes the profile in the
	// object path (`…/dev_AA_../sco/source`), which is the only remaining evidence.
	const segment = path.toUpperCase();
	return SCO_TRANSPORT_TOKENS.some((token) => segment.includes(`/${token}`));
}

/**
 * Read every SCO CAPTURE PCM out of a `GetManagedObjects` reply body.
 *
 * NEVER throws: a malformed, partial or entirely foreign payload degrades to an
 * empty list, because this runs inside the audio-device refresh and a parse
 * failure must read as "no Bluetooth microphone", never as a broken picker.
 */
export function parseBluealsaCapturePcms(
	body: DbusValue | undefined,
): BluealsaCapturePcm[] {
	if (!Array.isArray(body)) return [];
	const pcms: BluealsaCapturePcm[] = [];
	for (const entry of body) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const [path, interfaces] = entry;
		if (typeof path !== "string" || !Array.isArray(interfaces)) continue;
		for (const ifaceEntry of interfaces) {
			if (!Array.isArray(ifaceEntry) || ifaceEntry.length < 2) continue;
			const [iface, rawProps] = ifaceEntry;
			if (iface !== BLUEALSA_PCM_INTERFACE) continue;
			const props = decodeProps(rawProps);
			if (!isScoCapturePcm(props, path)) continue;
			const address =
				asString(variantValue(props, "Addr"))?.toUpperCase() ??
				addressFromObjectPath(asString(variantValue(props, "Device")) ?? "") ??
				addressFromObjectPath(path);
			if (address === undefined) continue;
			pcms.push({
				path,
				address,
				codec: asString(variantValue(props, "Codec")),
				sampleRateHz:
					asPositiveInteger(variantValue(props, "Sampling")) ??
					asPositiveInteger(variantValue(props, "Rate")),
				channels: asPositiveInteger(variantValue(props, "Channels")),
			});
		}
	}
	return pcms;
}

/**
 * The NEGOTIATED quality, or `undefined` when the PCM named no codec we can place.
 *
 * The rate and channel count are taken from the PCM when it published them and
 * derived from the codec otherwise — CVSD is narrowband 8 kHz mono and mSBC is
 * HFP 1.6 wideband 16 kHz mono, both by specification rather than by convention.
 * An UNRECOGNISED codec yields nothing at all: the frontend then renders the
 * honest "up to 16 kHz mono" ceiling, which is a bound rather than a claim.
 */
export function deriveBluetoothMicQuality(
	pcm: Pick<BluealsaCapturePcm, "codec"> &
		Partial<Pick<BluealsaCapturePcm, "sampleRateHz" | "channels">>,
): AudioSourceQuality | undefined {
	const token = pcm.codec?.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
	if (token === undefined) return undefined;
	if (token === "cvsd") {
		return {
			codec: "cvsd",
			sample_rate_hz: pcm.sampleRateHz ?? 8_000,
			channels: pcm.channels ?? 1,
		};
	}
	if (token === "msbc") {
		return {
			codec: "msbc",
			sample_rate_hz: pcm.sampleRateHz ?? 16_000,
			channels: pcm.channels ?? 1,
		};
	}
	return undefined;
}

export interface DeriveBluetoothAudioSourcesInput {
	readonly devices: readonly BluetoothAudioDevice[];
	readonly pcms: readonly BluealsaCapturePcm[];
	/** The engine advertises `audio-pcm-spec`; absent ⇒ every row disabled-with-reason. */
	readonly engineSupportsPcmSpec: boolean;
	readonly engineSupportsPipewireCapture?: boolean;
	readonly engineDevices?: readonly EngineAudioDevice[];
}

/**
 * Fold the BlueZ registry into backend-specific capture source rows.
 *
 * PipeWire rows require a connected SCO-capable BlueZ device and an engine audio
 * node with the same `device_address`; BlueALSA is not consulted. Legacy rows
 * instead require that device plus a live BlueALSA capture PCM. In either case,
 * a capture endpoint CeraUI cannot name is not shown in the picker.
 */
export function deriveBluetoothAudioSources(
	input: DeriveBluetoothAudioSourcesInput,
): BluetoothAudioSource[] {
	if (input.engineSupportsPipewireCapture === true) {
		const nodeByAddress = new Map<string, EngineAudioDevice>();
		for (const node of input.engineDevices ?? []) {
			const address = node.device_address;
			if (address === undefined || address === "") continue;
			const normalized = normalizeAddress(address);
			if (!nodeByAddress.has(normalized)) nodeByAddress.set(normalized, node);
		}

		const sources: BluetoothAudioSource[] = [];
		const seen = new Set<string>();
		for (const device of input.devices) {
			if (!device.connected || !device.scoCapable) continue;
			const address = device.address;
			if (address === undefined || address === "") continue;
			const normalized = normalizeAddress(address);
			const node = nodeByAddress.get(normalized);
			if (node === undefined || seen.has(normalized)) continue;
			seen.add(normalized);
			sources.push({
				id: bluetoothAudioSourceId(normalized),
				address: normalized,
				displayName: device.alias ?? device.name ?? normalized,
				pcmSpec: node.input_id,
				quality: undefined,
				unavailableReason: undefined,
			});
		}
		return sources;
	}

	const pcmByAddress = new Map<string, BluealsaCapturePcm>();
	for (const pcm of input.pcms) {
		if (!pcmByAddress.has(pcm.address)) pcmByAddress.set(pcm.address, pcm);
	}

	const sources: BluetoothAudioSource[] = [];
	const seen = new Set<string>();
	for (const device of input.devices) {
		if (!device.connected || !device.scoCapable) continue;
		const address = device.address?.toUpperCase();
		if (address === undefined || address.length === 0) continue;
		const pcm = pcmByAddress.get(address);
		if (pcm === undefined) continue;
		if (seen.has(address)) continue;
		seen.add(address);
		sources.push({
			id: bluetoothAudioSourceId(address),
			address,
			displayName: device.alias ?? device.name ?? address,
			pcmSpec: bluealsaScoPcmSpec(address),
			quality: deriveBluetoothMicQuality(pcm),
			unavailableReason: input.engineSupportsPcmSpec
				? undefined
				: AUDIO_SOURCE_UNAVAILABLE_REASONS.ENGINE_UPDATE_REQUIRED,
		});
	}
	return sources;
}

// ─── Live wiring ─────────────────────────────────────────────────────────────

export interface BluetoothAudioDeps {
	/** Enumerate the BlueALSA PCM objects; `undefined` ⇒ the bus could not be read. */
	readEnumeratedPcms: () => Promise<BluealsaCapturePcm[] | undefined>;
	readRegistryDevices: () => BluetoothAudioDevice[];
	engineSupportsPcmSpec: () => boolean;
	engineSupportsPipewireCapture: () => boolean;
	readEngineAudioDevices: () => readonly EngineAudioDevice[];
}

let deps: BluetoothAudioDeps | undefined;
let cachedSources: BluetoothAudioSource[] = [];
let cachedDevices: BluetoothAudioDevice[] = [];

export function setBluetoothAudioDepsForTest(
	next: BluetoothAudioDeps | undefined,
): void {
	deps = next;
}

export function resetBluetoothAudioForTest(): void {
	deps = undefined;
	cachedSources = [];
	cachedDevices = [];
}

async function defaultReadEnumeratedPcms(): Promise<
	BluealsaCapturePcm[] | undefined
> {
	const { createDbusTransport } = await import(
		"@ceralive/modem-control/transport"
	);
	const transport = createDbusTransport({ reconnect: { enabled: false } });
	try {
		await transport.connect();
		const reply = await transport.callMethod({
			destination: BLUEALSA_SERVICE,
			path: BLUEALSA_ROOT_PATH,
			interface: OBJECT_MANAGER_INTERFACE,
			member: "GetManagedObjects",
			timeoutMs: BLUEALSA_CALL_TIMEOUT_MS,
		});
		return parseBluealsaCapturePcms(reply.body[0]);
	} catch {
		// `bluealsad` not running, no name owner, or a bus we cannot reach. Each
		// is a statement about the READ, so the caller RETAINS what it had rather
		// than retracting a microphone that may still be perfectly openable.
		return undefined;
	} finally {
		try {
			await transport.disconnect();
		} catch {
			/* already gone */
		}
	}
}

function defaultReadRegistryDevices(): BluetoothAudioDevice[] {
	return cachedDevices;
}

/**
 * Publish the BlueZ registry projection.
 *
 * Called by the Bluetooth runtime rather than read from it, so this module keeps
 * NO import edge into `modules/bluetooth/` — that module owns the stack, and an
 * edge from the streaming graph into it would drag a D-Bus client onto the audio
 * module's load path.
 */
export function noteBluetoothRegistryDevices(
	devices: readonly BluetoothAudioDevice[],
): void {
	cachedDevices = [...devices];
}

function activeDeps(): BluetoothAudioDeps {
	return (
		deps ?? {
			readEnumeratedPcms: defaultReadEnumeratedPcms,
			readRegistryDevices: defaultReadRegistryDevices,
			engineSupportsPcmSpec: defaultEngineSupportsPcmSpec,
			engineSupportsPipewireCapture: defaultEngineSupportsPipewireCapture,
			readEngineAudioDevices: getEngineAudioDevices,
		}
	);
}

/**
 * FAIL-CLOSED: an engine that has not answered yet, or one that advertises no
 * `features` array at all, is an engine that cannot be shown to understand an
 * opaque PCM spec — so the row is disabled-with-reason rather than offered on a
 * guess that would fail at the leg.
 */
function defaultEngineSupportsPcmSpec(): boolean {
	return (
		getLastCapabilities()?.features?.includes(AUDIO_PCM_SPEC_FEATURE) === true
	);
}

function defaultEngineSupportsPipewireCapture(): boolean {
	return (
		getLastCapabilities()?.features?.includes(PIPEWIRE_CAPTURE_FEATURE) === true
	);
}

/**
 * Re-read the selected backend's source-presence data and rebuild the cached list.
 *
 * Answers whether the published list CHANGED, so the caller can keep the audio
 * broadcast on its on-change cadence. Never throws.
 */
export async function refreshBluetoothAudioSources(): Promise<boolean> {
	const active = activeDeps();
	const usesPipewire = active.engineSupportsPipewireCapture();
	let pcms: BluealsaCapturePcm[] | undefined;
	if (usesPipewire) {
		pcms = [];
	} else {
		try {
			pcms = await active.readEnumeratedPcms();
		} catch {
			pcms = undefined;
		}
	}
	if (pcms === undefined) return false;

	let next: BluetoothAudioSource[];
	try {
		next = deriveBluetoothAudioSources({
			devices: active.readRegistryDevices(),
			pcms,
			engineSupportsPcmSpec: active.engineSupportsPcmSpec(),
			engineSupportsPipewireCapture: usesPipewire,
			engineDevices: active.readEngineAudioDevices(),
		});
	} catch (err) {
		logger.warn(
			`bluetooth-audio: could not derive audio sources: ${String(err)}`,
		);
		return false;
	}

	if (JSON.stringify(next) === JSON.stringify(cachedSources)) return false;
	cachedSources = next;
	return true;
}

export async function refreshPipewireBluetoothAudioSourcesForEngineChange(): Promise<boolean> {
	if (!activeDeps().engineSupportsPipewireCapture()) return false;
	return refreshBluetoothAudioSources();
}

export function getBluetoothAudioSources(): readonly BluetoothAudioSource[] {
	return cachedSources;
}

/** The row a source id names, if it is still published. */
export function findBluetoothAudioSource(
	id: string,
): BluetoothAudioSource | undefined {
	return cachedSources.find((source) => source.id === id);
}

/**
 * What the registry currently says about the device an id names.
 *
 * The probe's failure detail reads this so an operator learns WHICH microphone
 * is missing and whether BlueZ still sees it at all. It can never make a device
 * present — the selected backend's matching capture endpoint does that.
 */
export function describeBluetoothAudioTarget(
	id: string,
): { displayName: string; connected: boolean } | undefined {
	if (!isBluetoothAudioSourceId(id)) return undefined;
	const address = normalizeAddress(id.slice(BLUETOOTH_AUDIO_ID_PREFIX.length));
	const device = cachedDevices.find(
		(entry) => entry.address?.toUpperCase() === address,
	);
	if (device === undefined) return { displayName: address, connected: false };
	return {
		displayName: device.alias ?? device.name ?? address,
		connected: device.connected,
	};
}
