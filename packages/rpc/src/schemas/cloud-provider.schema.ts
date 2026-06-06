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

import { z } from 'zod';

/**
 * How a relay was sourced: `subscription` (provider's authenticated WS push),
 * `manual` (user-entered SRTLA addr/port), `belabox` (BELABOX-compatible feed).
 */
export const DETECTION_METHODS = ['subscription', 'manual', 'belabox'] as const;
export const detectionMethodSchema = z.enum(DETECTION_METHODS);
export type DetectionMethod = (typeof DETECTION_METHODS)[number];

/**
 * Cloud provider endpoint configuration
 */
export const cloudProviderEndpointSchema = z.object({
	/** Unique provider identifier */
	id: z.string(),
	/** Display name for the provider */
	name: z.string(),
	/** WebSocket endpoint host */
	host: z.string(),
	/** WebSocket endpoint path */
	path: z.string().default('/ws/remote'),
	/** Whether to use secure WebSocket (wss) */
	secure: z.boolean().default(true),
	/** Cloud management URL for users to get their keys */
	cloudUrl: z.string().url().optional(),
	/** Protocol version (if different from default) */
	protocolVersion: z.number().optional(),
	/** How relays for this provider are detected (optional — legacy-safe) */
	detectionMethod: detectionMethodSchema.optional(),
});

export type CloudProviderEndpoint = z.infer<typeof cloudProviderEndpointSchema>;

/**
 * Predefined cloud providers
 */
export const CLOUD_PROVIDERS: CloudProviderEndpoint[] = [
	{
		id: 'ceralive',
		name: 'CeraLive Cloud',
		host: 'remote.ceralive.net',
		path: '/ws/remote',
		secure: true,
		cloudUrl: 'https://cloud.ceralive.net',
	},
	{
		id: 'belabox',
		name: 'BELABOX Cloud',
		host: 'remote.belabox.net',
		path: '/ws/remote',
		secure: true,
		cloudUrl: 'https://cloud.belabox.net',
	},
];

/**
 * Custom provider input schema (for user-defined providers)
 */
export const customProviderInputSchema = z.object({
	name: z.string().min(1, 'Provider name is required'),
	host: z.string().min(1, 'Host is required'),
	path: z.string().default('/ws/remote'),
	secure: z.boolean().default(true),
	cloudUrl: z.string().url().optional(),
});

export type CustomProviderInput = z.infer<typeof customProviderInputSchema>;

/**
 * Provider selection - either a predefined provider ID or "custom"
 */
export const providerSelectionSchema = z.union([
	z.literal('ceralive'),
	z.literal('belabox'),
	z.literal('custom'),
]);

export type ProviderSelection = z.infer<typeof providerSelectionSchema>;

/**
 * Remote key configuration with provider.
 *
 * Accepts either a raw `remote_key` (operator-entered, legacy) or a
 * platform-issued device `token` (claim-code pairing, ADR-0006). When a `token`
 * is present it becomes the active remote key. At least one of the two must be
 * supplied.
 */
export const remoteConfigInputSchema = z
	.object({
		/** The remote authentication key (operator-entered, legacy path). */
		remote_key: z.string().optional(),
		/** Platform-issued device token; stored as the active remote key when present. */
		token: z.string().optional(),
		/** Selected provider ID */
		provider: providerSelectionSchema.default('ceralive'),
		/** Custom provider configuration (required if provider is "custom") */
		custom_provider: customProviderInputSchema.optional(),
	})
	.refine((value) => value.remote_key !== undefined || value.token !== undefined, {
		message: 'Either remote_key or token must be provided',
		path: ['remote_key'],
	});

export type RemoteConfigInput = z.infer<typeof remoteConfigInputSchema>;

/**
 * Remote configuration stored in config
 */
export const remoteConfigSchema = z.object({
	remote_key: z.string().optional(),
	remote_provider: providerSelectionSchema.optional(),
	custom_provider: customProviderInputSchema.optional(),
});

export type RemoteConfig = z.infer<typeof remoteConfigSchema>;

/**
 * Get provider endpoint by ID
 */
export function getProviderById(
	id: ProviderSelection,
	customProvider?: CustomProviderInput,
): CloudProviderEndpoint | undefined {
	if (id === 'custom' && customProvider) {
		return {
			id: 'custom',
			...customProvider,
		};
	}
	return CLOUD_PROVIDERS.find((p) => p.id === id);
}

/**
 * Get all available providers (predefined + custom option)
 */
export function getAvailableProviders(): CloudProviderEndpoint[] {
	return [...CLOUD_PROVIDERS];
}
