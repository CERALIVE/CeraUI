/**
 * Remote topology envelope seam — design-only typed definitions (Task 4).
 *
 * This module defines the shape of the remote-profile envelope that will wrap
 * future RPC messages when the device connects to a cloud relay. These types
 * are DESIGN-ONLY: they exist to document the intended structure and allow
 * Task 19 (REMOTE_TOPOLOGY.md) to reference real symbols, but they have ZERO
 * runtime wiring. No handlers, no branches, no imports into executing paths.
 *
 * Future work (Ambition A remote profile) will wire these types into the
 * connection layer and message handlers.
 *
 * @future: not wired — design-only seam (Ambition A remote profile)
 */

import { z } from 'zod';

/**
 * Deployment mode: local device or remote cloud relay.
 *
 * - `"local"`: Device is the primary endpoint (current production mode).
 * - `"remote"`: Device dials OUT to a cloud relay (future Ambition A).
 *
 * @future: not wired — design-only seam (Ambition A remote profile)
 */
export const deploymentModeSchema = z.enum(['local', 'remote']);
export type DeploymentMode = z.infer<typeof deploymentModeSchema>;

/**
 * Session token credential for remote authentication.
 *
 * Short-lived token issued by the cloud relay after device authentication.
 * Replaces raw-password reconnect (see apps/frontend/src/lib/rpc/reconnect.ts:21-24)
 * in future remote-profile implementations.
 *
 * Shape:
 * - `token`: opaque string (JWT or similar, issued by relay)
 * - `expiresAt`: ISO 8601 timestamp when token becomes invalid
 * - `refreshToken`: optional long-lived token to obtain new session tokens
 *
 * @future: not wired — design-only seam (Ambition A remote profile)
 */
export const sessionTokenSchema = z.object({
	token: z.string().describe('Opaque session token (JWT or similar)'),
	expiresAt: z.string().datetime().describe('ISO 8601 expiration timestamp'),
	refreshToken: z.string().optional().describe('Optional long-lived refresh token'),
});
export type SessionToken = z.infer<typeof sessionTokenSchema>;

/**
 * Client visibility subscription — which views/data types the client wants to receive.
 *
 * The client sends this to the server to declare which data streams it is actively
 * viewing. The server uses this to optimize bandwidth on metered connections
 * (e.g., cellular relay). Each key is a view or data type; the value is a boolean
 * indicating whether the client is subscribed.
 *
 * Example:
 * ```json
 * {
 *   "streaming": true,
 *   "network": true,
 *   "settings": false,
 *   "hud": true
 * }
 * ```
 *
 * @future: not wired — design-only seam (Ambition A remote profile)
 */
export const visibilitySubscriptionSchema = z.record(z.string(), z.boolean()).describe(
	'Client visibility subscription: { [view/type]: boolean }',
);
export type VisibilitySubscription = z.infer<typeof visibilitySubscriptionSchema>;

/**
 * Remote envelope schema version.
 *
 * Numeric version field for future token migration detection and envelope
 * format evolution. Allows the server and client to negotiate compatible
 * envelope structures as the remote profile matures.
 *
 * Current: 1 (design-only, not yet wired)
 *
 * @future: not wired — design-only seam (Ambition A remote profile)
 */
export const schemaVersionSchema = z.number().int().positive().describe(
	'Envelope schema version for future migration detection',
);
export type SchemaVersion = z.infer<typeof schemaVersionSchema>;

/**
 * Complete remote topology envelope.
 *
 * Wraps RPC messages when the device is in remote mode (connected via cloud relay).
 * Contains deployment metadata, session credentials, client visibility preferences,
 * and schema versioning for future evolution.
 *
 * @future: not wired — design-only seam (Ambition A remote profile)
 */
export const remoteEnvelopeSchema = z.object({
	deploymentMode: deploymentModeSchema.describe('Deployment mode: local or remote'),
	sessionToken: sessionTokenSchema.optional().describe('Session token for remote auth'),
	visibilitySubscription: visibilitySubscriptionSchema.optional().describe(
		'Client visibility subscription',
	),
	schemaVersion: schemaVersionSchema.describe('Envelope schema version'),
});
export type RemoteEnvelope = z.infer<typeof remoteEnvelopeSchema>;
