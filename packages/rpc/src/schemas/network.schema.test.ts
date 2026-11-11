/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';

import {
	ethernetRoleMessageSchema,
	netifMessageSchema,
	setEthernetRoleInputSchema,
	uplinkFlowsResetEventSchema,
	uplinkShaperStatusSchema,
	uplinkSteeringStatusSchema,
} from './network.schema';

describe('Ethernet role operation correlation (#489)', () => {
	test.each([undefined, 'a'.repeat(16), '00'.repeat(16), 'AZaz09_-'.repeat(8)])(
		'round-trips optional op %j',
		(op) => {
			const correlation = op === undefined ? {} : { op };
			const input = { name: 'eth0', role: 'shared-lan' as const, ...correlation };
			expect(setEthernetRoleInputSchema.parse(input)).toEqual(input);
			for (const outcome of [
				{ role: 'shared-lan', pending: true },
				{ role: 'shared-lan', success: true },
				{ error: 'apply_failed' },
			] as const) {
				const frame = { eth_role: { name: 'eth0', ...outcome, ...correlation } };
				expect(ethernetRoleMessageSchema.parse(frame)).toEqual(frame);
			}
		},
	);

	test.each([
		{ label: 'empty', op: '' },
		{ label: 'below minimum', op: 'a'.repeat(15) },
		{ label: 'above maximum', op: 'a'.repeat(65) },
		{ label: '64 KiB', op: 'a'.repeat(65_536) },
		{ label: '1 MiB', op: 'a'.repeat(1_048_576) },
		{ label: 'NUL control', op: `${'a'.repeat(16)}\0` },
		{ label: 'escape control', op: `${'a'.repeat(16)}\u001b` },
		{ label: 'space', op: `${'a'.repeat(16)} ` },
		{ label: 'newline', op: `${'a'.repeat(16)}\n` },
		{ label: 'non-ASCII', op: `${'a'.repeat(16)}\u00e9` },
		{ label: 'null', op: null },
		{ label: 'number', op: 1 },
		{ label: 'boolean', op: true },
		{ label: 'object', op: {} },
		{ label: 'array', op: [] },
	])('rejects malformed $label on requests and frames', ({ op }) => {
		expect(setEthernetRoleInputSchema.safeParse({ name: 'eth0', role: 'uplink', op }).success).toBe(
			false,
		);
		for (const outcome of [
			{ role: 'shared-lan', pending: true },
			{ role: 'shared-lan', success: true },
			{ error: 'apply_failed' },
		]) {
			expect(
				ethernetRoleMessageSchema.safeParse({ eth_role: { name: 'eth0', ...outcome, op } }).success,
			).toBe(false);
		}
	});

	test('keeps request validation strict with the additive field', () => {
		expect(
			setEthernetRoleInputSchema.safeParse({
				name: 'eth0',
				role: 'uplink',
				op: 'a'.repeat(16),
				typo: true,
			}).success,
		).toBe(false);
		expect(
			setEthernetRoleInputSchema.safeParse({ name: 'eth0', role: 'wan', op: 'a'.repeat(16) })
				.success,
		).toBe(false);
	});

	test('retains the optional backend correlation capability', () => {
		const frame = { eth0: { tp: 0, enabled: true, ethRoleOp: true } };
		expect(netifMessageSchema.parse(frame)).toEqual(frame);
		expect(
			netifMessageSchema.safeParse({ eth0: { tp: 0, enabled: true, ethRoleOp: 'true' } }).success,
		).toBe(false);
	});
});

describe('legacy netif payloads', () => {
	test('strips USB serials from legacy router-cellular markers (#488)', () => {
		const marker = {
			vendor: 'Huawei',
			model: '14dc',
			vid_pid: '12d1:14dc',
			kind: 'router-cellular',
			duplicate_model: true,
		} as const;

		expect(
			netifMessageSchema.parse({
				eth1: {
					tp: 0,
					enabled: true,
					router_cellular: { ...marker, serial: 'test-legacy-unit' },
				},
			}),
		).toEqual({
			eth1: { tp: 0, enabled: true, router_cellular: marker },
		});
	});

	test('accepts but strips the retired policy-route diagnostic', () => {
		expect(
			netifMessageSchema.parse({
				wlan1: { tp: 0, enabled: true, ip: '192.168.1.50', policy_route_missing: true },
			}),
		).toEqual({
			wlan1: { tp: 0, enabled: true, ip: '192.168.1.50' },
		});
	});
});

describe('uplink steering wire schemas', () => {
	test('parses available and typed unavailable persistent states', () => {
		expect(uplinkSteeringStatusSchema.parse({ state: 'available' })).toEqual({
			state: 'available',
		});
		expect(
			uplinkSteeringStatusSchema.parse({
				state: 'steering_unavailable',
				reason: 'policy_route_missing',
				detail: 'wlan0: source rule is missing',
			}),
		).toEqual({
			state: 'steering_unavailable',
			reason: 'policy_route_missing',
			detail: 'wlan0: source rule is missing',
		});
	});

	test('rejects unknown unavailable reasons', () => {
		expect(
			uplinkSteeringStatusSchema.safeParse({
				state: 'steering_unavailable',
				reason: 'unknown',
			}).success,
		).toBe(false);
	});

	test('parses only identity-scoped hard-down reset events', () => {
		expect(
			uplinkFlowsResetEventSchema.parse({
				iface: 'wwan0',
				linkId: 'usb-serial:uplink-a',
			}),
		).toEqual({ iface: 'wwan0', linkId: 'usb-serial:uplink-a' });
		expect(
			uplinkFlowsResetEventSchema.safeParse({
				iface: 'wwan0',
				linkId: '',
			}).success,
		).toBe(false);
	});
});

describe('uplink shaper status', () => {
	test('reports the active algorithm or a priority-degraded refusal', () => {
		expect(
			uplinkShaperStatusSchema.parse({
				state: 'available',
				mode: 'streaming',
				algorithm: 'htb-fq_codel',
			}),
		).toEqual({ state: 'available', mode: 'streaming', algorithm: 'htb-fq_codel' });
		expect(
			uplinkShaperStatusSchema.parse({
				state: 'shaper_unavailable',
				reason: 'tc_apply_failed',
				priorityDegraded: true,
			}),
		).toEqual({ state: 'shaper_unavailable', reason: 'tc_apply_failed', priorityDegraded: true });
	});
});
