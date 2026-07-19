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
 * Zod schemas for all JSON configuration files
 * Used for validation and type-safe defaults
 *
 * `runtimeConfigSchema` is the SINGLE source of truth for the on-device
 * streaming config. It covers two concerns in one shape:
 *   1. runtime UI/streaming state persisted to `config.json` (relay target,
 *      audio, video, kiosk, add-ons, …), and
 *   2. the fields the engine backend serializes into its own config —
 *      `max_br`, `srt_latency`, `balancer` and `delay`.
 *
 * Engine-config serialization itself is NOT done here. It is an implementation
 * detail of `CerastreamBackend` (modules/streaming/cerastream-backend.ts), the
 * only place allowed to translate this schema into the engine's config format.
 * That keeps the wire format invisible above the StreamingBackend seam, so a
 * future engine can satisfy the same contract without a different config schema.
 *
 * `setup.json` (setupConfigSchema, below) is deliberately a SEPARATE schema. It
 * is boot-time hardware identity / path overrides written once at image-build /
 * first-run time (`hw`, exec + config paths, device dirs). It is read at module
 * load before the runtime config and is never mutated by the streaming flow, so
 * folding it into the runtime schema would conflate immutable boot identity with
 * mutable runtime state. They stay distinct on purpose.
 */

import {
	AddonConfigSchema,
	AUDIO_SOURCE_AUTO,
	audioCodecSchema,
	type DetectionMethod,
	detectionMethodSchema,
	deviceKindSchema,
	isNamespacedRelayId,
	kioskDisplaySchema,
	kioskPerformanceSchema,
	kioskStateSchema,
	namespacedRelayId,
	parseNamespacedRelayId,
	type RelayProtocol,
	relayProtocolSchema,
	relayProviderMetaSchema,
	resolverDecidedBySchema,
	SRTLA_MIN_LATENCY_MS,
	sourcesVisibilitySchema,
	streamProfileIdSchema,
	streamRecoveryPreferenceSchema,
} from "@ceraui/rpc/schemas";
import { z } from "zod";
import { logger } from "./logger.ts";

export type { DetectionMethod, RelayProtocol };
// Re-export the relay-id namespacing helpers so backend consumers resolve them
// from the config layer rather than reaching into @ceraui/rpc directly.
export {
	audioCodecSchema,
	detectionMethodSchema,
	isNamespacedRelayId,
	namespacedRelayId,
	parseNamespacedRelayId,
	relayProtocolSchema,
};

// =============================================================================
// Custom Provider Schema (shared between config and cloud-provider)
// =============================================================================

export const customProviderSchema = z.object({
	name: z.string(),
	host: z.string(),
	path: z.string().optional(),
	secure: z.boolean().optional(),
	cloudUrl: z.string().optional(),
});

export type CustomProvider = z.infer<typeof customProviderSchema>;

// =============================================================================
// Main Runtime Config (config.json)
// =============================================================================

export const providerSelectionSchema = z.enum([
	"ceralive",
	"belabox",
	"custom",
]);

// Legacy-tolerant wrapper for the runtime config `acodec` field: coerceLegacyAcodec
// remaps a retired "pcm" (C5) to "aac" before the strict @ceraui/rpc enum
// validates. Mirrors legacyTolerantStreamingEngineSchema below.
const legacyTolerantAudioCodecSchema = z.preprocess(
	coerceLegacyAcodec,
	audioCodecSchema,
);

// Video resolution/framerate presets — mirror the @ceraui/rpc streaming schema
// enums so persisted config round-trips cleanly.
export const resolutionSchema = z.enum([
	"480p",
	"720p",
	"1080p",
	"1440p",
	"2160p",
	"4k",
]);

// SECOND copy of the @ceraui/rpc framerate rung ladder (known duplication — kept
// engine-binding-free on purpose). MUST stay in parity: 23.98 (24000/1001,
// NTSC-film) + 24 (cine) are mirrored here so a persisted film-rate config parses.
export const framerateSchema = z.union([
	z.literal(23.98),
	z.literal(24),
	z.literal(25),
	z.literal(29.97),
	z.literal(30),
	z.literal(50),
	z.literal(59.94),
	z.literal(60),
]);

// Egress video codec — defined locally (like resolution/framerate above) to keep
// this schema free of an engine-binding dependency. Mirrors the @ceraui/rpc
// videoCodecSchema so persisted config round-trips cleanly.
export const videoCodecSchema = z.enum(["h264", "h265"]);

export type Resolution = z.infer<typeof resolutionSchema>;
export type Framerate = z.infer<typeof framerateSchema>;
export type VideoCodec = z.infer<typeof videoCodecSchema>;

// Bitrate balancer algorithm, defined locally — like resolution/framerate above
// — to keep this schema free of an engine-binding dependency.
export const balancerSchema = z.enum(["adaptive", "fixed", "aimd"]);

export type Balancer = z.infer<typeof balancerSchema>;

// Per-boot cellular-control backend selection. `mmcli` (default) is the legacy
// one-shot-CLI path; `dbus` selects the @ceralive/modem-control ModemManager
// backend, committed only after its first snapshot — see the commit/fallback
// contract in modules/cellular/cellular-stack.ts.
export const modemBackendSchema = z.enum(["mmcli", "dbus"]);

export type ModemBackend = z.infer<typeof modemBackendSchema>;

// One persisted last-seen capture-device snapshot (C7 lost-device retention),
// carrying exactly the fields `captureSourceSchema` needs to synthesize a `lost`
// row: `devicePath` is REQUIRED there, and `pipelineId` is the
// `deviceKindToPipelineId()` bridge resolved at observation time (only bridgeable
// video devices are ever snapshotted).
export const lastSeenDeviceSchema = z.object({
	id: z.string(),
	displayName: z.string(),
	kind: deviceKindSchema,
	pipelineId: z.string(),
	devicePath: z.string(),
});

export type LastSeenDevice = z.infer<typeof lastSeenDeviceSchema>;

export const runtimeConfigSchema = z.object({
	// Authentication
	password: z.string().optional(),
	password_hash: z.string().optional(),
	ssh_pass: z.string().optional(),
	ssh_pass_hash: z.string().optional(),

	// Relay/SRTLA settings
	relay_server: z.string().optional(),
	relay_account: z.string().optional(),
	relay_streamid_override: z.string().optional(),
	relay_protocol: relayProtocolSchema.optional(),
	srt_streamid: z.string().optional(),
	// Keep the VALIDATION min at 100 so a legacy sub-2s config still PARSES on
	// boot (raising it would reject the whole config); the transform floors the
	// value to the SRTLA minimum on load instead (T2 load-time normalization).
	srt_latency: z
		.number()
		.int()
		.min(100)
		.max(10000)
		.transform((v) => Math.max(v, SRTLA_MIN_LATENCY_MS))
		.optional(),
	// SRT receive-profile tuning (Tasks 18/19): FEC toggle + operator recovery
	// preference. Persisted device-side; only honoured by a CeraLive receiver.
	fec_enabled: z.boolean().optional(),
	recovery_mode: streamRecoveryPreferenceSchema.optional(),
	// Active SRT receive-profile preset id (or 'custom'). Persisted when the
	// platform pushes a profile via device.setProfile so the device can report
	// the effective active profile back and seed the Stream Tuning card.
	stream_profile: streamProfileIdSchema.optional(),
	// Who decided the active profile (device.setProfile `decidedBy`). Persisted so
	// the Stream Tuning card can surface a cloud-override affordance when the
	// cloud (operator/auto) pinned the profile (Task 21).
	profile_decided_by: resolverDecidedBySchema.optional(),
	srtla_addr: z.string().optional(),
	srtla_port: z.number().int().min(1).max(65535).optional(),
	// endpointId of the selected platform-pushed ingest slot (T18). The slot
	// IDENTITY is the endpointId, never host+port — host/port may change between
	// pushes while the operator's selection follows the stable endpointId.
	selected_ingest_endpoint: z.string().optional(),

	// Audio settings
	asrc: z.string().optional(),
	acodec: legacyTolerantAudioCodecSchema.optional(),

	// Video/streaming settings
	bitrate_overlay: z.boolean().optional(),
	max_br: z.number().int().min(500).max(50000).optional(),
	delay: z.number().int().min(-2000).max(2000).optional(),
	balancer: balancerSchema.optional(),
	pipeline: z.string().optional(),
	resolution: resolutionSchema.optional(),
	framerate: framerateSchema.optional(),
	// Egress video codec + operator-selected video input_id (Todo 19). Additive
	// optional, same style as resolution/framerate above; absent = engine default.
	video_codec: videoCodecSchema.optional(),
	selected_video_input: z.string().optional(),
	// Device-first operator source selection (StreamSource id). Additive-optional;
	// `pipeline`/`selected_video_input` stay the engine-wire fields DERIVED from it
	// at the procedure layer (T3). A legacy config without it back-derives `source`
	// via `coerceLegacySource` at load time.
	source: z.string().optional(),
	// Operator-ordered video-source preference (input_id list, most-preferred
	// first). Persisted so a device-first reorder survives reload; setConfig
	// writes it, getConfig echoes it. Additive-optional.
	source_preference: z.array(z.string()).optional(),
	// Last-seen capture-device snapshots (C7): deduped-by-id, LRU-capped at 12
	// with the current `config.source` id eviction-exempt. Serves the
	// across-restart lost-row case (a configured device unplugged before boot);
	// an in-session lost row is served by the uncapped in-memory session map, not
	// this list. Additive-optional; defaults `[]` so old configs parse.
	last_seen_devices: z.array(lastSeenDeviceSchema).optional(),
	autostart: z.boolean().optional(),

	// Remote/cloud settings
	remote_key: z.string().optional(),
	// Platform Device.id (UUID) from the device-control token claim (spec §9/§10),
	// persisted at pairing time. initIdentity() only reads it — never mints one.
	device_id: z.uuid().optional(),
	remote_provider: providerSelectionSchema.optional(),
	custom_provider: customProviderSchema.optional(),
	// Device-pairing claim-code seed. Persistent crypto-random secret that seeds
	// the HMAC claim-code derivation so codes stay stable across backend
	// restarts within a window. Created on first use; never leaves the device.
	pairing_secret: z.string().optional(),
	// How the active relay selection was sourced. "subscription" is set when a
	// provider's authenticated catalog push auto-preloads server/account.
	detectionMethod: detectionMethodSchema.optional(),

	// Kiosk toggle state machine (DC-2). `kiosk_enabled` is the user toggle;
	// `kiosk_last_state` restores the UI state on restart without waiting for the
	// first poll; the remaining fields are the persisted display profile.
	kiosk_enabled: z.boolean().optional(),
	kiosk_last_state: kioskStateSchema.optional(),
	kiosk_display: kioskDisplaySchema.optional(),
	kiosk_touch: z.boolean().optional(),
	kiosk_motion: z.boolean().optional(),
	kiosk_performance: kioskPerformanceSchema.optional(),

	// Per-add-on runtime state (id -> AddonState): device-local metadata only,
	// never the sysext `.raw` payload bytes.
	addons: AddonConfigSchema.optional(),

	// Operator enable/disable of the LAN RTMP/SRT network-ingest gateways (T6). A
	// missing key (old config) defaults both protocols enabled via the inner
	// defaults; kept `.optional()` so `let config: RuntimeConfig = {}` still parses.
	network_ingest: z
		.object({
			rtmp_enabled: z.boolean().default(true),
			srt_enabled: z.boolean().default(true),
		})
		.optional(),

	// Device-wide source visibility (config-only row visibility for the virtual
	// test-pattern origin — NOT a service gate). A missing key (old config) leaves
	// every source visible via the inner default; kept `.optional()` so
	// `let config: RuntimeConfig = {}` still parses (E3 additive pattern).
	sources_visibility: sourcesVisibilitySchema.optional(),

	// Per-boot cellular-control backend selection. Absent (old config) resolves to
	// the mmcli default in the composition root — no default is injected here so an
	// existing config's echo stays byte-identical (additive-optional).
	modem_backend: modemBackendSchema.optional(),

	// Opt-in `modem_shadow` observation (Phase B). When true, the read-only
	// @ceralive/modem-control observer runs BESIDE the active (mmcli) backend and
	// logs redacted divergences — it never becomes the control path and never
	// mutates the bus. Additive-optional with no injected default: an absent key
	// (old config) echoes byte-identical and shadow mode stays off.
	modem_shadow: z.boolean().optional(),

	// Opt-in `modem_provisioning` gate (Phase B, T5.4). DEFAULT-ABSENT: while this
	// key is absent (every existing device that hasn't opted in) the guarded
	// USB-composition-mode mutation is UNREACHABLE — the setUsbMode RPC refuses
	// with a typed error at entry, not merely hidden in the UI. No default is
	// injected here so an absent key echoes byte-identical (additive-optional);
	// the mutation stays off until an operator explicitly provisions it.
	modem_provisioning: z.boolean().optional(),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

// Default values for runtime config (used when fields are missing)
export const RUNTIME_CONFIG_DEFAULTS: Partial<RuntimeConfig> = {
	// A MISSING asrc now defaults to the "Auto" sentinel: the audio source follows
	// the video source, resolved at start/idle-preview (auto-audio.ts). This covers
	// n100/generic (previously undefined → engine test-tone) and subsumes the
	// former static per-board guess in config.ts. A PRESENT asrc is untouched.
	asrc: AUDIO_SOURCE_AUTO,
	srt_latency: 2000,
	max_br: 5000,
	delay: 0,
	balancer: "adaptive",
	bitrate_overlay: false,
	autostart: false,
	kiosk_enabled: false,
	kiosk_last_state: "disabled",
	kiosk_display: "lcd",
	kiosk_touch: true,
	kiosk_motion: true,
	kiosk_performance: "balanced",
	addons: {},
	last_seen_devices: [],
};

export const DEFAULT_RELAY_PROVIDER_ID = "ceralive";

// Pure, idempotent migration: upgrades legacy flat relay ids ("0") to the
// provider-qualified form ("ceralive:0") on read; pass-through otherwise.
export function normalizeRelayIds(config: RuntimeConfig): RuntimeConfig {
	const providerId = config.remote_provider ?? DEFAULT_RELAY_PROVIDER_ID;
	const next: RuntimeConfig = { ...config };

	if (next.relay_server && !isNamespacedRelayId(next.relay_server)) {
		next.relay_server = namespacedRelayId(providerId, next.relay_server);
	}
	if (next.relay_account && !isNamespacedRelayId(next.relay_account)) {
		next.relay_account = namespacedRelayId(providerId, next.relay_account);
	}

	return next;
}

// Back-derive the device-first `source` id from legacy config fields when it is
// absent (pre-source configs persisted only pipeline/selected_video_input). Pure,
// idempotent, and NEVER throws — mirrors the legacy `engine` coercion's
// boot-tolerant contract (one warning line, never a parse failure). A present
// `source` passes through untouched. Derivation ladder:
//   selected_video_input present → that input_id (a capture source)
//   pipeline in {rtmp, srt}       → that pipeline id (a network source)
//   pipeline === 'test'           → 'test' (the virtual source)
//   pipeline present              → that pipeline id (a coarse source)
//   otherwise                     → left unset
export function coerceLegacySource(config: RuntimeConfig): RuntimeConfig {
	if (config.source !== undefined) return config;

	let derived: string | undefined;
	if (config.selected_video_input !== undefined) {
		derived = config.selected_video_input;
	} else if (config.pipeline === "rtmp" || config.pipeline === "srt") {
		derived = config.pipeline;
	} else if (config.pipeline === "test") {
		derived = "test";
	} else if (config.pipeline !== undefined) {
		derived = config.pipeline;
	}

	if (derived === undefined) return config;

	logger.warn(
		`config.json: no 'source' field — derived source ${JSON.stringify(
			derived,
		)} from legacy pipeline/selected_video_input for the device-first source model`,
	);
	return { ...config, source: derived };
}

// Legacy audio-codec coercion (C5): a persisted, retired `acodec: "pcm"` maps to
// "aac" with one warning; every other value passes through untouched for the
// strict enum to validate. Wired into runtimeConfigSchema's acodec preprocess so
// a legacy pcm config loads clean instead of dropping the field. Pure, log-once
// — mirrors coerceLegacySource's boot-tolerant contract.
export function coerceLegacyAcodec(raw: unknown): unknown {
	if (raw === "pcm") {
		logger.warn(
			'config.json: audio codec "pcm" is retired — coercing to "aac" (C5)',
		);
		return "aac";
	}
	return raw;
}

// =============================================================================
// Setup Config (setup.json)
// =============================================================================

export const hardwareTypeSchema = z.enum(["jetson", "n100", "rk3588"]);

// The streaming engine behind the StreamingBackend seam. cerastream is the ONLY
// engine since the legacy engine was retired (post Task 37 boot-parity
// flip); the field survives as boot identity so setup.json stays explicit and
// forward-extensible.
export const streamingEngineSchema = z.literal("cerastream");
export type StreamingEngine = z.infer<typeof streamingEngineSchema>;

// MIGRATION TOLERANCE: devices in the field may still have a legacy engine name
// persisted in setup.json. Boot must never crash on it — any legacy/unknown
// value is coerced to "cerastream" with one warning line.
const legacyTolerantStreamingEngineSchema = streamingEngineSchema.catch(
	(ctx) => {
		const raw = (ctx as { input?: unknown }).input;
		// An absent key also flows through here under `.optional()` — only a
		// present-but-unsupported value deserves the migration warning.
		if (raw !== undefined) {
			logger.warn(
				`setup.json: unsupported streaming engine ${JSON.stringify(
					raw,
				)} — legacy engines are retired; coercing to "cerastream"`,
			);
		}
		return "cerastream" as const;
	},
);

export const setupConfigSchema = z.object({
	hw: hardwareTypeSchema,
	engine: legacyTolerantStreamingEngineSchema.optional(),
	// Cerastream control-socket / exec overrides.
	cerastream_path: z.string().optional(),
	cerastream_socket: z.string().optional(),

	srtla_path: z.string().optional(),
	sound_device_dir: z.string().optional(),
	usb_device_dir: z.string().optional(),
	mmcli_binary: z.string().optional(),
	killall_binary: z.string().optional(),
	bcrpt_path: z.string().optional(),
	ips_file: z.string().optional(),
	// Legacy belaUI setup.json fields read at runtime (opt-in overrides).
	ssh_user: z.string().optional(),
	apt_update_enabled: z.boolean().optional(),
	has_gsm_autoconfig: z.boolean().optional(),
	remote_protocol_version: z.number().optional(),
	remote_endpoint_secure: z.boolean().optional(),
	remote_endpoint_host: z.string().optional(),
	remote_endpoint_path: z.string().optional(),
});

export type SetupConfig = z.infer<typeof setupConfigSchema>;

// Default paths based on hardware
export const SETUP_CONFIG_DEFAULTS: Partial<SetupConfig> = {
	engine: "cerastream",
	ips_file: "/tmp/srtla_ips",
};

// =============================================================================
// Auth Tokens (auth_tokens.json)
// =============================================================================

export const authTokensSchema = z.record(z.string(), z.literal(true));

export type AuthTokens = z.infer<typeof authTokensSchema>;

// =============================================================================
// DNS Cache (dns_cache.json)
// =============================================================================

export const dnsCacheEntrySchema = z.object({
	ts: z.number(),
	results: z.array(z.string()),
});

export const dnsCacheSchema = z.record(z.string(), dnsCacheEntrySchema);

export type DnsCacheEntry = z.infer<typeof dnsCacheEntrySchema>;
export type DnsCache = z.infer<typeof dnsCacheSchema>;

// =============================================================================
// GSM Operator Cache (gsm_operator_cache.json)
// =============================================================================

export const gsmOperatorCacheSchema = z.record(z.string(), z.string());

export type GsmOperatorCache = z.infer<typeof gsmOperatorCacheSchema>;

// =============================================================================
// Relay Server Entry Schema
// =============================================================================

export const relayServerSchema = z.object({
	type: z.string(),
	name: z.string(),
	addr: z.string(),
	port: z.number().int().min(1).max(65535),
	default: z.literal(true).optional(),
	bcrp_port: z.string().optional(),
	// Provider origin; optional so legacy untagged caches round-trip. Shape
	// frozen in @ceraui/rpc relay.schema.ts — reused here, never redefined.
	provider: relayProviderMetaSchema.optional(),
});

export type RelayServer = z.infer<typeof relayServerSchema>;

// =============================================================================
// Relay Account Entry Schema
// =============================================================================

export const relayAccountSchema = z.object({
	name: z.string(),
	ingest_key: z.string(),
	disabled: z.literal(true).optional(),
	// Provider origin; optional so legacy untagged caches round-trip. Shape
	// frozen in @ceraui/rpc relay.schema.ts — reused here, never redefined.
	provider: relayProviderMetaSchema.optional(),
});

export type RelayAccount = z.infer<typeof relayAccountSchema>;

// =============================================================================
// Relays Cache (relays_cache.json)
// =============================================================================

export const relaysCacheSchema = z.object({
	bcrp_key: z.string().optional(),
	servers: z.record(z.string(), relayServerSchema),
	accounts: z.record(z.string(), relayAccountSchema),
});

export type RelaysCache = z.infer<typeof relaysCacheSchema>;

// Default for empty relay cache
export const RELAYS_CACHE_DEFAULTS: RelaysCache = {
	servers: {},
	accounts: {},
};

// =============================================================================
// Deployment Config (deployment/config.json)
// This is typically just an initial password for first-time setup
// =============================================================================

export const deploymentConfigSchema = z.object({
	password: z.string().optional(),
	password_hash: z.string().optional(),
});

export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;
