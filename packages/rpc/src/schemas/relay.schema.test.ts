/**
 * Relay/transport schema tests (Task 3 — RELAY)
 *
 * Covers:
 *  (a) old config.json fixture still parses (migration-safe)
 *  (b) new fields (provider metadata, protocol) validate
 *  (c) provider-qualified relay-id namespacing round-trips
 *  (d) future protocol values are accepted by the schema (enum placeholders)
 */
import { describe, expect, test } from 'bun:test';

// Backend config schema — the canonical config.json shape. Imported by
// relative path because @ceraui/rpc must NOT import the backend (and the
// backend resolves @ceraui/rpc as a workspace dep, so this is the only
// direction that avoids a circular package edge).
import {
	type RuntimeConfig,
	normalizeRelayIds,
	runtimeConfigSchema,
} from '../../../../apps/backend/src/helpers/config-schemas';
import {
	type DetectionMethod,
	detectionMethodSchema,
} from './cloud-provider.schema';
import {
	isNamespacedRelayId,
	namespacedRelayId,
	parseNamespacedRelayId,
	relayAccountSchema,
	relayMessageSchema,
	relayProtocolSchema,
	relayProviderKindSchema,
	relayProviderMetaSchema,
	relayServerSchema,
} from './relay.schema';

describe('relay.schema — backward compatibility (old config parses)', () => {
	test('(a) old config.json (flat ids, no provider/protocol) parses without throw', () => {
		const oldConfig = {
			password_hash: '$argon2id$abc',
			relay_server: '0',
			relay_account: '1',
			srt_streamid: 'legacystreamid',
			srt_latency: 2000,
			max_br: 5000,
			delay: 0,
			bitrate_overlay: false,
			autostart: false,
			remote_key: 'deadbeef',
			remote_provider: 'ceralive',
		};
		const parsed = runtimeConfigSchema.parse(oldConfig);
		expect(parsed.relay_server).toBe('0');
		expect(parsed.relay_account).toBe('1');
		expect(parsed.srt_streamid).toBe('legacystreamid');
	});

	test('(a) old relay WS push (server/account without provider/protocol) parses', () => {
		const oldServer = { name: 'Frankfurt', rtt: 12, default: true } as const;
		const oldAccount = { name: 'Primary' } as const;
		expect(() => relayServerSchema.parse(oldServer)).not.toThrow();
		expect(() => relayAccountSchema.parse(oldAccount)).not.toThrow();

		const oldMessage = {
			servers: { '0': oldServer },
			accounts: { '1': oldAccount },
		};
		const parsed = relayMessageSchema.parse(oldMessage);
		expect(parsed.servers['0']?.name).toBe('Frankfurt');
		// protocol defaults to srtla when absent
		expect(parsed.servers['0']?.protocol).toBe('srtla');
	});
});

describe('relay.schema — new fields validate', () => {
	test('(b) provider metadata validates on server and account', () => {
		const provider = {
			id: 'ceralive',
			name: 'CeraLive Cloud',
			kind: 'ceralive',
		};
		expect(() => relayProviderMetaSchema.parse(provider)).not.toThrow();

		const server = {
			name: 'Frankfurt',
			rtt: 10,
			protocol: 'srtla',
			provider,
		};
		const parsedServer = relayServerSchema.parse(server);
		expect(parsedServer.provider?.id).toBe('ceralive');
		expect(parsedServer.protocol).toBe('srtla');

		const account = { name: 'Primary', provider };
		const parsedAccount = relayAccountSchema.parse(account);
		expect(parsedAccount.provider?.kind).toBe('ceralive');
	});

	test('(b) provider kind enum accepts ceralive/belabox/custom', () => {
		for (const kind of ['ceralive', 'belabox', 'custom'] as const) {
			expect(() => relayProviderKindSchema.parse(kind)).not.toThrow();
		}
		expect(() => relayProviderKindSchema.parse('bogus')).toThrow();
	});

	test('(b) detectionMethod enum accepts subscription/manual/belabox', () => {
		for (const m of ['subscription', 'manual', 'belabox'] as const) {
			const parsed: DetectionMethod = detectionMethodSchema.parse(m);
			expect(parsed).toBe(m);
		}
		expect(() => detectionMethodSchema.parse('telepathy')).toThrow();
	});
});

describe('relay.schema — protocol enum (placeholders)', () => {
	test('(d) protocol defaults to srtla', () => {
		expect(relayProtocolSchema.parse(undefined)).toBe('srtla');
	});

	test('(d) future protocol values srt and rist are accepted by the schema', () => {
		expect(relayProtocolSchema.parse('srt')).toBe('srt');
		expect(relayProtocolSchema.parse('rist')).toBe('rist');
	});

	test('(d) unknown protocol value is rejected', () => {
		expect(() => relayProtocolSchema.parse('quic')).toThrow();
	});
});

describe('relay-id namespacing', () => {
	test('(c) namespacedRelayId builds providerId:serverId', () => {
		expect(namespacedRelayId('ceralive', '0')).toBe('ceralive:0');
		expect(namespacedRelayId('belabox', 'fra-1')).toBe('belabox:fra-1');
	});

	test('(c) parse round-trips a namespaced id', () => {
		const id = namespacedRelayId('ceralive', 'fra-1');
		const parts = parseNamespacedRelayId(id);
		expect(parts.providerId).toBe('ceralive');
		expect(parts.serverId).toBe('fra-1');
		expect(namespacedRelayId(parts.providerId ?? '', parts.serverId)).toBe(id);
	});

	test('(c) parse tolerates a flat (legacy) id', () => {
		const parts = parseNamespacedRelayId('0');
		expect(parts.providerId).toBeUndefined();
		expect(parts.serverId).toBe('0');
	});

	test('(c) isNamespacedRelayId distinguishes flat vs namespaced', () => {
		expect(isNamespacedRelayId('ceralive:0')).toBe(true);
		expect(isNamespacedRelayId('0')).toBe(false);
	});

	test('(c) serverId containing a colon survives round-trip (split on first colon only)', () => {
		const parts = parseNamespacedRelayId('ceralive:host:9000');
		expect(parts.providerId).toBe('ceralive');
		expect(parts.serverId).toBe('host:9000');
	});
});

describe('migration normalizer', () => {
	test('upgrades flat relay ids to namespaced form using the configured provider', () => {
		const old: RuntimeConfig = {
			relay_server: '0',
			relay_account: '1',
			remote_provider: 'belabox',
		};
		const migrated = normalizeRelayIds(old);
		expect(migrated.relay_server).toBe('belabox:0');
		expect(migrated.relay_account).toBe('belabox:1');
	});

	test('defaults to ceralive provider when none configured', () => {
		const migrated = normalizeRelayIds({ relay_server: '0' });
		expect(migrated.relay_server).toBe('ceralive:0');
	});

	test('is idempotent — already-namespaced ids are left untouched', () => {
		const once = normalizeRelayIds({
			relay_server: '0',
			relay_account: '1',
			remote_provider: 'ceralive',
		});
		const twice = normalizeRelayIds(once);
		expect(twice.relay_server).toBe('ceralive:0');
		expect(twice.relay_account).toBe('ceralive:1');
	});

	test('leaves config without relay ids untouched (manual SRTLA)', () => {
		const manual: RuntimeConfig = {
			srtla_addr: '1.2.3.4',
			srtla_port: 5000,
			srt_streamid: 'mystream',
		};
		const migrated = normalizeRelayIds(manual);
		expect(migrated.relay_server).toBeUndefined();
		expect(migrated.srtla_addr).toBe('1.2.3.4');
	});

	test('does not mutate the input config', () => {
		const input: RuntimeConfig = { relay_server: '0', remote_provider: 'ceralive' };
		normalizeRelayIds(input);
		expect(input.relay_server).toBe('0');
	});
});

describe('relay_streamid_override (editable stream id)', () => {
	test('optional override field parses when present', () => {
		const parsed = runtimeConfigSchema.parse({
			relay_account: 'ceralive:1',
			relay_streamid_override: 'custom-stream-key',
		});
		expect(parsed.relay_streamid_override).toBe('custom-stream-key');
	});

	test('override is absent on old config (undefined, no throw)', () => {
		const parsed = runtimeConfigSchema.parse({ relay_account: '1' });
		expect(parsed.relay_streamid_override).toBeUndefined();
	});
});
