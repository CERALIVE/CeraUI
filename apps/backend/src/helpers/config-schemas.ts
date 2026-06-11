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
 *   2. the fields the encoder backend turns into `ceracoder.conf` INI —
 *      `max_br` (→ general.max_bitrate), `srt_latency` (→ srt.latency),
 *      `balancer` (→ general.balancer) and `delay` (→ run-arg A/V delay).
 *
 * INI serialization itself is NOT done here. It is an implementation detail of
 * `CeracoderBackend` (modules/streaming/ceracoder-backend.ts), the only place
 * allowed to translate this schema into the engine's `ceracoder.conf` grammar.
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
	type DetectionMethod,
	detectionMethodSchema,
	isNamespacedRelayId,
	kioskDisplaySchema,
	kioskPerformanceSchema,
	kioskStateSchema,
	namespacedRelayId,
	parseNamespacedRelayId,
	type RelayProtocol,
	relayProtocolSchema,
} from "@ceraui/rpc/schemas";
import { z } from "zod";

export type { DetectionMethod, RelayProtocol };
// Re-export the relay-id namespacing helpers so backend consumers resolve them
// from the config layer rather than reaching into @ceraui/rpc directly.
export {
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

export const audioCodecSchema = z.enum(["opus", "aac", "pcm"]);

// Video resolution/framerate presets — mirror the ceracoder PipelineOverrides
// and @ceraui/rpc streaming schema enums so persisted config round-trips cleanly.
export const resolutionSchema = z.enum([
	"480p",
	"720p",
	"1080p",
	"1440p",
	"2160p",
	"4k",
]);

export const framerateSchema = z.union([
	z.literal(25),
	z.literal(29.97),
	z.literal(30),
	z.literal(50),
	z.literal(59.94),
	z.literal(60),
]);

// Mirrors ceracoder's `balancerAlgorithmSchema` (→ `[general] balancer` INI),
// defined locally — like resolution/framerate above — to keep this schema free
// of an engine-binding dependency.
export const balancerSchema = z.enum(["adaptive", "fixed", "aimd"]);

export type Balancer = z.infer<typeof balancerSchema>;

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
	srt_latency: z.number().int().min(100).max(10000).optional(),
	srtla_addr: z.string().optional(),
	srtla_port: z.number().int().min(1).max(65535).optional(),

	// Audio settings
	asrc: z.string().optional(),
	acodec: audioCodecSchema.optional(),

	// Video/streaming settings
	bitrate_overlay: z.boolean().optional(),
	max_br: z.number().int().min(500).max(50000).optional(),
	delay: z.number().int().min(-2000).max(2000).optional(),
	balancer: balancerSchema.optional(),
	pipeline: z.string().optional(),
	resolution: resolutionSchema.optional(),
	framerate: framerateSchema.optional(),
	autostart: z.boolean().optional(),

	// Remote/cloud settings
	remote_key: z.string().optional(),
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
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

// Default values for runtime config (used when fields are missing)
export const RUNTIME_CONFIG_DEFAULTS: Partial<RuntimeConfig> = {
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

// =============================================================================
// Setup Config (setup.json)
// =============================================================================

export const hardwareTypeSchema = z.enum(["jetson", "n100", "rk3588"]);

// Which streaming engine the backend drives behind the StreamingBackend seam.
// Boot identity, not a runtime UI toggle: it is read once at startup to pick the
// engine implementation (ceracoder INI/spawn vs cerastream structured IPC). The
// image / first-run setup.json owns the value. Task 37 flipped the default to
// "cerastream" after the generic boot-parity gate passed
// (cerastream/docs/notes/boot-parity-results.md). Absent ⇒ "cerastream" (see
// SETUP defaults). ceracoder stays selectable until the hardware-gated profiles
// also pass and it is removed from the image.
export const streamingEngineSchema = z.enum(["ceracoder", "cerastream"]);
export type StreamingEngine = z.infer<typeof streamingEngineSchema>;

export const setupConfigSchema = z.object({
	hw: hardwareTypeSchema,
	engine: streamingEngineSchema.optional(),
	// Ceracoder settings
	ceracoder_path: z.string().optional(),
	ceracoder_config: z.string().optional(),
	// Cerastream control-socket / exec overrides (parity with ceracoder paths).
	cerastream_path: z.string().optional(),
	cerastream_socket: z.string().optional(),

	srtla_path: z.string().optional(),
	sound_device_dir: z.string().optional(),
	usb_device_dir: z.string().optional(),
	mmcli_binary: z.string().optional(),
	killall_binary: z.string().optional(),
	bcrpt_path: z.string().optional(),
	ips_file: z.string().optional(),
});

export type SetupConfig = z.infer<typeof setupConfigSchema>;

// Default paths based on hardware
export const SETUP_CONFIG_DEFAULTS: Partial<SetupConfig> = {
	engine: "cerastream",
	// Ceracoder config path for -c and SIGHUP reload
	ceracoder_config: "/tmp/ceracoder.conf",

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
});

export type RelayServer = z.infer<typeof relayServerSchema>;

// =============================================================================
// Relay Account Entry Schema
// =============================================================================

export const relayAccountSchema = z.object({
	name: z.string(),
	ingest_key: z.string(),
	disabled: z.literal(true).optional(),
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
