/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';

import { uplinkFlowsResetEventSchema, uplinkSteeringStatusSchema } from './network.schema';

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
