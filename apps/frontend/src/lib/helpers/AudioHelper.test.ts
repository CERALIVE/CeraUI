import { describe, it, expect } from 'vitest';
import { getAudioSourceLabel } from './AudioHelper';

describe('AudioHelper', () => {
	describe('getAudioSourceLabel', () => {
		const notAvailableSentinel = 'NOT_AVAILABLE';
		const selectPlaceholder = 'Select audio source';

		it('should return short readable id unchanged', () => {
			const result = getAudioSourceLabel('HDMI', {
				available: ['HDMI', 'USB'],
				notAvailableSentinel,
				selectPlaceholder,
			});
			expect(result).toBe('HDMI');
		});

		it('should return another short id unchanged', () => {
			const result = getAudioSourceLabel('USB', {
				available: ['HDMI', 'USB'],
				notAvailableSentinel,
				selectPlaceholder,
			});
			expect(result).toBe('USB');
		});

		it('should return notAvailableSentinel with (Not Available) suffix', () => {
			const t = (key: string) => {
				if (key === 'settings.notAvailableAudioSource') return 'Not Available';
				return key;
			};
			const result = getAudioSourceLabel(notAvailableSentinel, {
				available: ['HDMI'],
				notAvailableSentinel,
				selectPlaceholder,
				t,
			});
			expect(result).toBe('NOT_AVAILABLE (Not Available)');
		});

		it('should return selectPlaceholder for falsy source', () => {
			const result = getAudioSourceLabel('', {
				available: ['HDMI'],
				notAvailableSentinel,
				selectPlaceholder,
			});
			expect(result).toBe('Select audio source');
		});

		it('should return selectPlaceholder for null source', () => {
			const result = getAudioSourceLabel(null as any, {
				available: ['HDMI'],
				notAvailableSentinel,
				selectPlaceholder,
			});
			expect(result).toBe('Select audio source');
		});

		it('should return selectPlaceholder for undefined source', () => {
			const result = getAudioSourceLabel(undefined as any, {
				available: ['HDMI'],
				notAvailableSentinel,
				selectPlaceholder,
			});
			expect(result).toBe('Select audio source');
		});

		it('should guard against absurdly long hash-like id (length > 20)', () => {
			const longHashId = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0';
			const t = (key: string) => {
				if (key === 'general.unknownSource') return 'Unknown source';
				return key;
			};
			const result = getAudioSourceLabel(longHashId, {
				available: [],
				notAvailableSentinel,
				selectPlaceholder,
				t,
			});
			// Should NOT return the full 40-char string
			expect(result).not.toBe(longHashId);
			expect(result.length).toBeLessThanOrEqual(20);
		});

		it('should return general.unknownSource for long hash-like id when t provided', () => {
			const longHashId = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0';
			const t = (key: string) => {
				if (key === 'general.unknownSource') return 'Unknown source';
				return key;
			};
			const result = getAudioSourceLabel(longHashId, {
				available: [],
				notAvailableSentinel,
				selectPlaceholder,
				t,
			});
			expect(result).toBe('Unknown source');
		});

		it('should truncate long id to first 20 chars if no t provided', () => {
			const longHashId = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0';
			const result = getAudioSourceLabel(longHashId, {
				available: [],
				notAvailableSentinel,
				selectPlaceholder,
			});
			expect(result).toBe('a1b2c3d4e5f6g7h8i9j0');
		});

		it('should preserve short ids even if they look like hashes', () => {
			const shortHash = 'a1b2c3d4e5f6g7h8i9j0'; // exactly 20 chars
			const result = getAudioSourceLabel(shortHash, {
				available: [shortHash],
				notAvailableSentinel,
				selectPlaceholder,
			});
			expect(result).toBe(shortHash);
		});

		it('should guard against 21-char id (just over threshold)', () => {
			const almostLongId = 'a1b2c3d4e5f6g7h8i9j0k'; // 21 chars
			const t = (key: string) => {
				if (key === 'general.unknownSource') return 'Unknown source';
				return key;
			};
			const result = getAudioSourceLabel(almostLongId, {
				available: [],
				notAvailableSentinel,
				selectPlaceholder,
				t,
			});
			expect(result).not.toBe(almostLongId);
		});
	});
});
