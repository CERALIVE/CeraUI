/**
 * intersectCaps capability-intersection tests.
 *
 * TDD: locks the layered platform ∩ source ∩ mode intersection, the
 * media_type → source-kind mapping, and the None-cap permissive policy.
 */
import { describe, expect, it } from 'bun:test';
import {
	captureCapResolution,
	type CaptureFormatCap,
	intersectCaps,
	MEDIA_TYPE_H264,
	MEDIA_TYPE_H265,
	mediaTypeToSourceKind,
	type PlatformCaps,
	type VideoSourceCap,
} from './intersect-caps';

// A platform that tops out at 1080p (ladder: 480p, 720p, 1080p) with H.265.
const platform1080: PlatformCaps = {
	supports_h265: true,
	hardware_accelerated: true,
	max_resolution: '1080p',
};

// A source pinned to 1080p — overrides forbidden, so it narrows the offered set.
const pinned1080Source: VideoSourceCap = {
	id: 'libuvch264',
	supports_audio: true,
	supports_resolution_override: false,
	supports_framerate_override: false,
	default_resolution: '1080p',
	default_framerate: 30,
};

describe('intersectCaps', () => {
	describe('happy path — layered platform ∩ source intersection', () => {
		it('narrows to the source default when the platform supports {1080p,720p} and the source pins {1080p}', () => {
			const offered = intersectCaps(platform1080, pinned1080Source, 'streaming');

			// platform ladder is {480p,720p,1080p}; the pinned source collapses it to {1080p}.
			expect(offered.resolutions).toEqual(['1080p']);
			expect(offered.framerates).toEqual([30]);
			expect(offered.supportsResolutionOverride).toBe(false);
			expect(offered.supportsFramerateOverride).toBe(false);
			expect(offered.supportsAudio).toBe(true);
		});

		it('offers the full platform ladder when the source allows overrides', () => {
			const flexibleSource: VideoSourceCap = {
				...pinned1080Source,
				id: 'hdmi',
				supports_resolution_override: true,
				supports_framerate_override: true,
			};

			const offered = intersectCaps(platform1080, flexibleSource, 'streaming');

			expect(offered.resolutions).toEqual(['480p', '720p', '1080p']);
			expect(offered.framerates).toEqual([25, 29.97, 30, 50, 59.94, 60]);
		});

		it('caps the ladder at the platform max_resolution (4k alias → 2160p)', () => {
			const platform4k: PlatformCaps = { ...platform1080, max_resolution: '4k' };
			const flexibleSource: VideoSourceCap = {
				...pinned1080Source,
				supports_resolution_override: true,
			};

			const offered = intersectCaps(platform4k, flexibleSource, 'streaming');

			expect(offered.resolutions).toEqual(['480p', '720p', '1080p', '1440p', '2160p']);
		});

		it('offers H.265 only when the platform advertises it', () => {
			const withH265 = intersectCaps(platform1080, pinned1080Source, 'streaming');
			expect(withH265.codecs).toEqual([MEDIA_TYPE_H264, MEDIA_TYPE_H265]);

			const noH265 = intersectCaps(
				{ ...platform1080, supports_h265: false },
				pinned1080Source,
				'streaming',
			);
			expect(noH265.codecs).toEqual([MEDIA_TYPE_H264]);
		});

		it('returns the canonical bitrate window', () => {
			const offered = intersectCaps(platform1080, pinned1080Source, 'streaming');
			expect(offered.bitrateRange).toEqual({ min: 500, max: 50000, unit: 'kbps' });
		});

		it('is pure — the same inputs always yield an equivalent result and inputs are untouched', () => {
			const platformSnapshot = structuredClone(platform1080);
			const sourceSnapshot = structuredClone(pinned1080Source);

			const a = intersectCaps(platform1080, pinned1080Source, 'streaming');
			const b = intersectCaps(platform1080, pinned1080Source, 'streaming');

			expect(a).toEqual(b);
			expect(platform1080).toEqual(platformSnapshot);
			expect(pinned1080Source).toEqual(sourceSnapshot);
		});
	});

	describe('media_type → source-kind mapping', () => {
		it('maps a UVC device advertising video/x-h265 to the uvc_h265 source-kind', () => {
			expect(mediaTypeToSourceKind('video/x-h265')).toBe('uvc_h265');
		});

		it('maps video/x-h264 to the uvc_h264 source-kind', () => {
			expect(mediaTypeToSourceKind('video/x-h264')).toBe('uvc_h264');
		});

		it('maps raw video to camlink or hdmi based on the source id', () => {
			expect(mediaTypeToSourceKind('video/x-raw', 'camlink')).toBe('camlink');
			expect(mediaTypeToSourceKind('video/x-raw', 'hdmi0')).toBe('hdmi');
			expect(mediaTypeToSourceKind('video/x-raw')).toBe('hdmi');
		});

		it('leaves an unknown or absent media_type unclassified (permissive)', () => {
			expect(mediaTypeToSourceKind('video/x-vp9')).toBeUndefined();
			expect(mediaTypeToSourceKind(undefined)).toBeUndefined();
		});
	});

	describe('None-cap permissive policy', () => {
		it('treats a capture format with undefined width/height as permissive (offered, not dropped)', () => {
			const noDims: CaptureFormatCap = {
				width: undefined,
				height: undefined,
				media_type: 'video/x-h264',
			};

			// undefined dims → no dimensional constraint → undefined ("imposes no
			// restriction"), so the source stays offered rather than being dropped.
			expect(captureCapResolution(noDims)).toBeUndefined();
		});

		it('still classifies the source-kind of a dimensionless UVC H.265 format', () => {
			const noDims: CaptureFormatCap = { media_type: 'video/x-h265' };
			expect(captureCapResolution(noDims)).toBeUndefined();
			expect(mediaTypeToSourceKind(noDims.media_type)).toBe('uvc_h265');
		});

		it('resolves a concrete height to its rung when dimensions are present', () => {
			expect(captureCapResolution({ width: 1920, height: 1080 })).toBe('1080p');
		});

		it('treats an undefined source as fully permissive — full platform ladder, all overrides live', () => {
			const offered = intersectCaps(platform1080, undefined, 'streaming');

			expect(offered.resolutions).toEqual(['480p', '720p', '1080p']);
			expect(offered.framerates).toEqual([25, 29.97, 30, 50, 59.94, 60]);
			expect(offered.supportsAudio).toBe(true);
			expect(offered.supportsResolutionOverride).toBe(true);
			expect(offered.supportsFramerateOverride).toBe(true);
		});
	});
});
