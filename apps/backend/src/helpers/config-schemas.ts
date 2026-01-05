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
 */

import { z } from "zod";

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

export const runtimeConfigSchema = z.object({
	// Authentication
	password: z.string().optional(),
	password_hash: z.string().optional(),
	ssh_pass: z.string().optional(),
	ssh_pass_hash: z.string().optional(),

	// Relay/SRTLA settings
	relay_server: z.string().optional(),
	relay_account: z.string().optional(),
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
	pipeline: z.string().optional(),
	autostart: z.boolean().optional(),

	// Remote/cloud settings
	remote_key: z.string().optional(),
	remote_provider: providerSelectionSchema.optional(),
	custom_provider: customProviderSchema.optional(),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

// Default values for runtime config (used when fields are missing)
export const RUNTIME_CONFIG_DEFAULTS: Partial<RuntimeConfig> = {
	srt_latency: 2000,
	max_br: 5000,
	delay: 0,
	bitrate_overlay: false,
	autostart: false,
};

// =============================================================================
// Setup Config (setup.json)
// =============================================================================

export const hardwareTypeSchema = z.enum(["jetson", "n100", "rk3588"]);

export const setupConfigSchema = z.object({
	hw: hardwareTypeSchema,
	belacoder_path: z.string().optional(),
	srtla_path: z.string().optional(),
	sound_device_dir: z.string().optional(),
	usb_device_dir: z.string().optional(),
	mmcli_binary: z.string().optional(),
	killall_binary: z.string().optional(),
	bcrpt_path: z.string().optional(),
	bitrate_file: z.string().optional(),
	ips_file: z.string().optional(),
});

export type SetupConfig = z.infer<typeof setupConfigSchema>;

// Default paths based on hardware
export const SETUP_CONFIG_DEFAULTS: Partial<SetupConfig> = {
	bitrate_file: "/tmp/belacoder_br",
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
