import { describe, expect, it } from 'bun:test';

import { audioMixWithPrimary } from './streaming.schema';

const entry = (id: string, tracks = [1]) => ({ id, tracks, gain_db: 0, mute: false, delay_ms: 0 });
const A = entry('a');
const B2 = entry('b', [2]);

describe('audioMixWithPrimary', () => {
	it('a main input outside the saved mix joins first on Track 1 at its defaults, the rest as saved', () => {
		expect(audioMixWithPrimary([A, B2], 'c', 4)).toEqual([entry('c'), A, B2]);
	});

	it('a main input already in the saved mix leaves the mix as saved', () => {
		expect(audioMixWithPrimary([A, B2], 'b', 4)).toEqual([A, B2]);
	});

	it("in a full mix the main input takes the previous main input's place and tracks", () => {
		expect(audioMixWithPrimary([A, B2], 'c', 2, 'b')).toEqual([entry('c', [2]), A]);
	});

	it('in a full mix without a known previous main input, the first entry (saved first) is replaced', () => {
		expect(audioMixWithPrimary([entry('a', [1, 3]), B2], 'c', 2)).toEqual([entry('c', [1, 3]), B2]);
	});

	it('without a saved mix there is no mix, and without a main input the mix is as saved', () => {
		expect(audioMixWithPrimary(undefined, 'c', 4)).toBeUndefined();
		expect(audioMixWithPrimary([], 'c', 4)).toBeUndefined();
		expect(audioMixWithPrimary([A, B2], undefined, 4)).toEqual([A, B2]);
	});
});
