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
 * - `srtla` and `rist` are active in the runtime resolver. `rist` is
 *   additionally capability-gated: the engine must advertise RIST support (built
 *   with `--features rist`) before the resolver will route to it (Task 19/20).
 * - `srt` is a reserved placeholder: accepted by the schema so future relay
 *   pushes round-trip, but rejected by the runtime resolver until its transport
 *   is implemented.
 *
 * Defaults to `srtla` so old payloads (which carry no protocol field) normalise
 * to the active protocol on read.
 */
export const RELAY_PROTOCOLS = ['srtla', 'srt', 'rist'] as const;
export const relayProtocolSchema = z.enum(RELAY_PROTOCOLS).default('srtla');
export type RelayProtocol = (typeof RELAY_PROTOCOLS)[number];

/** Protocols with a working runtime resolver (`srt` is still a placeholder). */
export const ACTIVE_RELAY_PROTOCOLS = ['srtla', 'rist'] as const;

/** Active protocols that require an engine capability before they are selectable. */
export const CAPABILITY_GATED_RELAY_PROTOCOLS = ['rist'] as const;

/** The transport id the engine advertises for the RIST capability. */
export const RIST_TRANSPORT = 'rist';

/** Why a protocol is not currently selectable, for the UI's disabled reason. */
export type RelayProtocolUnavailableReason = 'reserved' | 'capability';

export interface RelayProtocolAvailability {
	selectable: boolean;
	reason?: RelayProtocolUnavailableReason;
}

/**
 * Resolve whether a relay protocol can be selected given the engine's advertised
 * transports. Shared by the UI (option gating) and the backend (resolver gate)
 * so both honour one rule: `srtla` always selectable, `rist` only when the
 * engine advertises it, `srt` never (reserved).
 */
export function relayProtocolAvailability(
	protocol: RelayProtocol,
	availableTransports: readonly string[] | undefined,
): RelayProtocolAvailability {
	if (protocol === 'srtla') return { selectable: true };
	if (!(ACTIVE_RELAY_PROTOCOLS as readonly string[]).includes(protocol)) {
		return { selectable: false, reason: 'reserved' };
	}
	const advertised = availableTransports ?? [];
	if ((CAPABILITY_GATED_RELAY_PROTOCOLS as readonly string[]).includes(protocol)) {
		return advertised.includes(protocol)
			? { selectable: true }
			: { selectable: false, reason: 'capability' };
	}
	return { selectable: true };
}

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
	/**
	 * Transports this single server endpoint can honor. ADDITIVE + OPTIONAL: a
	 * managed relay may advertise more than one transport for the same host/port
	 * (e.g. an endpoint that serves both `srtla` and `rist`). Absent on every
	 * legacy/current payload — when missing, the server supports exactly its
	 * scalar `protocol` (see `serverSupportedProtocols`). Adding this does NOT
	 * change `protocol`, which stays the canonical single-transport field.
	 */
	protocols: z.array(relayProtocolSchema).optional(),
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
// Receiver kind (transport × destination)
// =============================================================================

/**
 * The receiver "kind" is the cross product of transport (srtla/rist/srt) and
 * destination (managed relay vs. custom endpoint). It is a pure UI/derivation
 * concept owned by this RPC schema layer — it is NOT persisted. The backend's
 * decoupled relay-cache shape (`apps/backend/src/helpers/config-schemas.ts`
 * `relaysCacheSchema`) is unchanged in Scope A; nothing here writes a new
 * config field.
 *
 * `srt` has no managed variant in Scope A, so there is no `srt_relay`.
 */
export const RECEIVER_KINDS = [
	'srtla_relay',
	'srtla_custom',
	'rist_relay',
	'rist_custom',
	'srt_custom',
] as const;
export type ReceiverKind = (typeof RECEIVER_KINDS)[number];

export interface DeriveReceiverKindInput {
	protocol: RelayProtocol | undefined;
	hasRelayServer: boolean;
}

/**
 * Derive the receiver kind from the persisted shape. `protocol` is parsed
 * through `relayProtocolSchema` so a legacy config with no protocol field
 * (undefined) coerces to `srtla` — matching how the config round-trips.
 *
 * Reload caveat (documented, not a bug): the relay-override case persists
 * `srtla_addr/port + relay_streamid_override` with NO `relay_server`, so on
 * reload `hasRelayServer` is false and this returns `srtla_custom`. The override
 * does NOT round-trip back to `srtla_relay` — there is no persisted server to
 * key the managed destination off of.
 */
export function deriveReceiverKind({ protocol, hasRelayServer }: DeriveReceiverKindInput): ReceiverKind {
	const resolved = relayProtocolSchema.parse(protocol);
	switch (resolved) {
		case 'srtla':
			return hasRelayServer ? 'srtla_relay' : 'srtla_custom';
		case 'rist':
			return hasRelayServer ? 'rist_relay' : 'rist_custom';
		case 'srt':
			return 'srt_custom';
	}
}

export type ReceiverField = 'provider' | 'server' | 'account' | 'streamid' | 'addr' | 'port' | 'secret';

export interface ReceiverKindManifest {
	destination: 'managed' | 'custom';
	bonded: boolean;
	fields: ReceiverField[];
	requiresStreamId: boolean;
	requiresEvenPort: boolean;
}

/**
 * Per-kind form manifest for the receiver dialog. `requiresStreamId` is ADVISORY
 * ONLY — it drives a hint, never a Save gate. `rist_*` require an even data port
 * (simple-profile) and treat the stream id as optional.
 */
export function receiverKindManifest(kind: ReceiverKind): ReceiverKindManifest {
	switch (kind) {
		case 'srtla_relay':
			return {
				destination: 'managed',
				bonded: true,
				fields: ['provider', 'server', 'account', 'streamid'],
				requiresStreamId: true,
				requiresEvenPort: false,
			};
		case 'srtla_custom':
			return {
				destination: 'custom',
				bonded: true,
				fields: ['addr', 'port', 'streamid', 'secret'],
				requiresStreamId: true,
				requiresEvenPort: false,
			};
		case 'rist_relay':
			return {
				destination: 'managed',
				bonded: false,
				fields: ['provider', 'server', 'account', 'streamid'],
				requiresStreamId: false,
				requiresEvenPort: true,
			};
		case 'rist_custom':
			return {
				destination: 'custom',
				bonded: false,
				fields: ['addr', 'port', 'streamid', 'secret'],
				requiresStreamId: false,
				requiresEvenPort: true,
			};
		case 'srt_custom':
			return {
				destination: 'custom',
				bonded: false,
				fields: ['addr', 'port', 'streamid', 'secret'],
				requiresStreamId: true,
				requiresEvenPort: false,
			};
	}
}

/**
 * Transports a single relay server supports. Falls back to the scalar
 * `protocol` when the additive `protocols` array is absent or empty, so legacy
 * and current single-transport payloads behave exactly as before.
 */
export function serverSupportedProtocols(server: RelayServer): RelayProtocol[] {
	if (server.protocols && server.protocols.length > 0) return server.protocols;
	return [server.protocol];
}

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
