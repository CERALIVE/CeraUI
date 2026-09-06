/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
	type MediaBlockLoad,
	mediaBlockLoadSchema,
	mppSessionOwnerSchema,
} from './media-load.schema.js';
import { type EncoderLoad, encoderLoadSchema } from './system.schema.js';

const legacy = {
	source: 'clk-enable-count',
	cores: [{ core: 'rkvenc0', kind: 'active', active: true }],
	updatedAt: 123,
	simulated: false,
} satisfies EncoderLoad;

const mpp = {
	source: 'mpp-service',
	block: 'rkvenc',
	cores: [
		{
			core: 'fdbd0000.rkvenc-core',
			load: 150.25,
			utilization: 120.75,
			sessions: [{ pid: 4242, index: 7 }],
		},
	],
} satisfies MediaBlockLoad;

describe('media-load wire compatibility', () => {
	test('keeps every legacy payload byte-compatible and adds no default', () => {
		expect(encoderLoadSchema.parse(legacy)).toEqual(legacy);
	});
	test('retains block metrics and ownership through the existing event schema', () => {
		const message = { ...legacy, blocks: [mpp] };
		expect(encoderLoadSchema.parse(message)).toEqual(message);
	});
	test.each(['load', 'utilization', 'sessions'])(
		'requires explicit %s inside an instrumented core',
		(key) => {
			const core = { core: 'fdbd0000.rkvenc-core', load: 0, utilization: 0, sessions: null };
			const partial = Object.fromEntries(Object.entries(core).filter(([name]) => name !== key));
			expect(mediaBlockLoadSchema.safeParse({ ...mpp, cores: [partial] }).success).toBe(false);
		},
	);
	test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
		'refuses invalid raw percentages %s',
		(load) => {
			expect(
				mediaBlockLoadSchema.safeParse({ ...mpp, cores: [{ ...mpp.cores[0], load }] }).success,
			).toBe(false);
		},
	);
	test('refuses a fabricated RGA utilization or session owner', () => {
		const rga = {
			source: 'rkrga',
			block: 'rga',
			cores: [{ core: 'scheduler[0]: rga3', load: 12, utilization: null, sessions: null }],
		} satisfies MediaBlockLoad;
		expect(mediaBlockLoadSchema.parse(rga)).toEqual(rga);
		for (const change of [{ utilization: 12 }, { sessions: [] }, { load: 101 }]) {
			expect(
				mediaBlockLoadSchema.safeParse({ ...rga, cores: [{ ...rga.cores[0], ...change }] }).success,
			).toBe(false);
		}
	});
	test('binds each block to the interface that can actually publish it', () => {
		expect(mediaBlockLoadSchema.safeParse({ ...mpp, block: 'rga' }).success).toBe(false);
		expect(mediaBlockLoadSchema.safeParse({ ...mpp, source: 'rkrga' }).success).toBe(false);
		expect(mediaBlockLoadSchema.safeParse({ ...mpp, block: 'av1' }).success).toBe(false);
		expect(mediaBlockLoadSchema.safeParse({ ...mpp, cores: [] }).success).toBe(false);
	});
	test.each([
		{ pid: 0, index: 1 },
		{ pid: 1, index: -1 },
		{ pid: 1.5, index: 1 },
		{ pid: 1, index: 2 ** 54 },
	])('rejects an invalid session identity %j', (owner) => {
		expect(mppSessionOwnerSchema.safeParse(owner).success).toBe(false);
	});
});
