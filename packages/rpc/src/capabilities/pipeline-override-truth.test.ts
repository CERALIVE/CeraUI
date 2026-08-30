import { describe, expect, it } from 'vitest';

import {
	PIPELINE_OVERRIDE_FIELDS,
	supportsPipelineOverride,
	unsupportedPipelineOverrides,
} from './pipeline-override-truth';

const INGEST = {
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
} as const;
const CAPTURE = {
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
} as const;

describe('unsupportedPipelineOverrides', () => {
	it('reports both axes an ingest pipeline cannot honor', () => {
		expect(unsupportedPipelineOverrides(INGEST, { resolution: '720p', framerate: 30 })).toEqual([
			'resolution',
			'framerate',
		]);
	});

	it('reports nothing for a pipeline that honors both', () => {
		expect(unsupportedPipelineOverrides(CAPTURE, { resolution: '720p', framerate: 30 })).toEqual(
			[],
		);
	});

	// An absent override is nothing to reconcile: a config that never carried one
	// must be left byte-identical, or every save on an ingest source would report
	// a clear it did not perform.
	it('reports nothing when no override is carried at all', () => {
		expect(unsupportedPipelineOverrides(INGEST, {})).toEqual([]);
		expect(
			unsupportedPipelineOverrides(INGEST, { resolution: undefined, framerate: undefined }),
		).toEqual([]);
	});

	it('reports only the carried axis', () => {
		expect(unsupportedPipelineOverrides(INGEST, { resolution: '1080p' })).toEqual(['resolution']);
		expect(unsupportedPipelineOverrides(INGEST, { framerate: 60 })).toEqual(['framerate']);
	});

	it('reports each axis against its OWN support flag', () => {
		const resolutionOnly = {
			supportsResolutionOverride: true,
			supportsFramerateOverride: false,
		};
		expect(
			unsupportedPipelineOverrides(resolutionOnly, { resolution: '720p', framerate: 30 }),
		).toEqual(['framerate']);
	});

	it('answers per field through the shared predicate', () => {
		expect(supportsPipelineOverride(INGEST, 'resolution')).toBe(false);
		expect(supportsPipelineOverride(CAPTURE, 'framerate')).toBe(true);
		expect(PIPELINE_OVERRIDE_FIELDS).toEqual(['resolution', 'framerate']);
	});
});
