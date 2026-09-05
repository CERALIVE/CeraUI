import { describe, expect, test } from 'bun:test';
import { updateStateSchema } from './system.schema.js';

describe('update preflight wire contract', () => {
	test.each([
		'insufficient_space',
		'apt_config_failed',
		'archive_path_invalid',
		'probe_failed',
		'probe_no_uri_rows',
		'probe_uri_size_malformed',
		'probe_delta_malformed',
		'stat_failed',
		'statfs_failed',
		'value_out_of_range',
		'pre_clean_failed',
	])('preserves the terminal when the reason is %s', (preflight_reason) => {
		// Given a declared terminal reason.
		const frame = { kind: 'update_preflight_failed', preflight_reason } as const;
		// When it crosses the shared boundary.
		const parsed = updateStateSchema.safeParse(frame);
		// Then neither the kind nor the sub-cause is lost.
		expect(parsed).toEqual({ success: true, data: frame });
	});

	test.each([undefined, '', 'unknown', 'post_clean_failed'])(
		'refuses an undeclared preflight reason %s',
		(preflight_reason) => {
			// Given an unknown or missing reason; when parsed; then fail closed.
			expect(
				updateStateSchema.safeParse({ kind: 'update_preflight_failed', preflight_reason }).success,
			).toBe(false);
		},
	);

	test.each([{ kind: 'success' }, { kind: 'success', cleanup_warning: 'post_clean_failed' }])(
		'round-trips success without injecting a warning: %j',
		(frame) => {
			// Given either success shape; when parsed; then retain exactly that shape.
			expect(updateStateSchema.parse(frame)).toEqual(frame);
		},
	);

	test('refuses an unknown cleanup warning when success carries one', () => {
		// Given an undeclared warning; when parsed; then refuse it rather than strip it.
		expect(
			updateStateSchema.safeParse({ kind: 'success', cleanup_warning: 'unknown' }).success,
		).toBe(false);
	});
});
