/**
 * Relay Zod schemas
 */
import { z } from 'zod';

// =============================================================================
// Transport protocol
// =============================================================================

/**
 * Relay transport protocol.
 *
 * - `srtla` is the only protocol active in the runtime resolver today.
 * - `srt` and `rist` are reserved placeholders: accepted by the schema so that
 *   future relay pushes round-trip, but rejected by the runtime resolver until
 *   their transports are implemented.
 *
 * Defaults to `srtla` so old payloads (which carry no protocol field) normalise
 * to the active protocol on read.
 */
export const RELAY_PROTOCOLS = ['srtla', 'srt', 'rist'] as const;
export const relayProtocolSchema = z.enum(RELAY_PROTOCOLS).default('srtla');
export type RelayProtocol = (typeof RELAY_PROTOCOLS)[number];

// =============================================================================
// Provider metadata
// =============================================================================

/** Origin of a relay server/account. Mirrors the cloud provider taxonomy. */
export const RELAY_PROVIDER_KINDS = ['ceralive', 'belabox', 'custom'] as const;
export const relayProviderKindSchema = z.enum(RELAY_PROVIDER_KINDS);
export type RelayProviderKind = (typeof RELAY_PROVIDER_KINDS)[number];

/**
 * Provider metadata attached to a relay server/account so the UI can group and
 * label relays by their origin. Optional everywhere for migration safety.
 */
export const relayProviderMetaSchema = z.object({
	/** Stable provider identifier (e.g. "ceralive", "belabox", or a custom id) */
	id: z.string(),
	/** Human-readable provider name */
	name: z.string(),
	/** Provider taxonomy */
	kind: relayProviderKindSchema,
});
export type RelayProviderMeta = z.infer<typeof relayProviderMetaSchema>;

// =============================================================================
// Relay account / server
// =============================================================================

// Relay account schema
export const relayAccountSchema = z.object({
	name: z.string(),
	/** Provider this account belongs to (optional — absent on legacy payloads) */
	provider: relayProviderMetaSchema.optional(),
});
export type RelayAccount = z.infer<typeof relayAccountSchema>;

// Relay server schema
export const relayServerSchema = z.object({
	name: z.string(),
	rtt: z.number().optional(),
	default: z.literal(true).optional(),
	/**
	 * Resolved SRTLA host. Optional so legacy/minimal catalog pushes round-trip;
	 * surfaced READ-ONLY by ServerDialog as the auto-preloaded endpoint (Task 16).
	 */
	addr: z.string().optional(),
	/** Resolved SRTLA port (paired with `addr`). Optional for legacy payloads. */
	port: z.number().optional(),
	/** Transport protocol; defaults to "srtla" when absent on legacy payloads */
	protocol: relayProtocolSchema,
	/** Provider this server belongs to (optional — absent on legacy payloads) */
	provider: relayProviderMetaSchema.optional(),
});
export type RelayServer = z.infer<typeof relayServerSchema>;

// Relay message schema
export const relayMessageSchema = z.object({
	accounts: z.record(z.string(), relayAccountSchema),
	servers: z.record(z.string(), relayServerSchema),
});
export type RelayMessage = z.infer<typeof relayMessageSchema>;

// =============================================================================
// Provider-qualified relay-id namespacing
// =============================================================================

/** Separator between provider id and server/account id in a namespaced id. */
export const RELAY_ID_SEPARATOR = ':';

/** Parsed parts of a (possibly namespaced) relay id. */
export interface RelayIdParts {
	/** Provider id — undefined for legacy flat ids that carry no namespace. */
	providerId?: string;
	/** Server or account id. */
	serverId: string;
}

/**
 * Build a provider-qualified relay id: `${providerId}:${serverId}`.
 *
 * Used to disambiguate server/account ids that collide across providers once
 * multiple providers can be configured simultaneously.
 */
export function namespacedRelayId(providerId: string, serverId: string): string {
	return `${providerId}${RELAY_ID_SEPARATOR}${serverId}`;
}

/**
 * Split a relay id into its provider/server parts.
 *
 * Legacy flat ids (no separator) yield `{ providerId: undefined, serverId }`.
 * Only the first separator is significant, so server ids that themselves
 * contain a colon (e.g. `host:port`) survive a round-trip.
 */
export function parseNamespacedRelayId(id: string): RelayIdParts {
	const idx = id.indexOf(RELAY_ID_SEPARATOR);
	if (idx === -1) return { serverId: id };
	return {
		providerId: id.slice(0, idx),
		serverId: id.slice(idx + RELAY_ID_SEPARATOR.length),
	};
}

/** True when the id carries a provider namespace. */
export function isNamespacedRelayId(id: string): boolean {
	return id.includes(RELAY_ID_SEPARATOR);
}

// =============================================================================
// Manual custom-relay validation (relay.validate RPC)
// =============================================================================

export const RELAY_VALIDATE_STAGES = [
	'input',
	'protocol',
	'endpoint',
	'dns',
	'probe',
	'ok',
] as const;
export const relayValidateStageSchema = z.enum(RELAY_VALIDATE_STAGES);
export type RelayValidateStage = (typeof RELAY_VALIDATE_STAGES)[number];

export const relayValidateInputSchema = z.object({
	addr: z.string(),
	port: z.number(),
	streamid: z.string().optional(),
	passphrase: z.string().optional(),
	protocol: relayProtocolSchema.optional(),
});
export type RelayValidateInput = z.infer<typeof relayValidateInputSchema>;

export const relayValidateOutputSchema = z.object({
	valid: z.boolean(),
	stage: relayValidateStageSchema,
	reason: z.string().optional(),
});
export type RelayValidateOutput = z.infer<typeof relayValidateOutputSchema>;
