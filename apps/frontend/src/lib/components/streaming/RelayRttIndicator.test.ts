// @vitest-environment jsdom
/**
 * RelayRttIndicator — relay round-trip-time quality badge (Task 12 / decision D7).
 *
 * The backend sends a raw `rtt` number (or omits it); this component owns the
 * thresholds and the visual mapping:
 *   ≤ 80 ms  → green  (good)
 *   81–150 ms → yellow (fair)
 *   > 150 ms → red    (weak)
 *   undefined → neutral "—" (no measurement yet)
 *
 * The tier is surfaced on the element as `data-rtt-tier` so the mapping is
 * assertable without coupling to exact CSS variable strings, and the visible
 * text is checked for the "{rtt} ms" / "—" contract.
 */
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';

import RelayRttIndicator from './RelayRttIndicator.svelte';

const badge = () => screen.getByLabelText(/\d+\s*ms|\u2014/);

describe('RelayRttIndicator — RTT quality mapping (Task 12 / D7)', () => {
	it('renders green for rtt at the good ceiling (80 ms)', () => {
		render(RelayRttIndicator, { props: { rtt: 80 } });
		expect(badge().getAttribute('data-rtt-tier')).toBe('good');
		expect(badge().textContent?.trim()).toBe('80 ms');
	});

	it('renders green for a low rtt (40 ms)', () => {
		render(RelayRttIndicator, { props: { rtt: 40 } });
		expect(badge().getAttribute('data-rtt-tier')).toBe('good');
	});

	it('renders yellow just above the good ceiling (81 ms)', () => {
		render(RelayRttIndicator, { props: { rtt: 81 } });
		expect(badge().getAttribute('data-rtt-tier')).toBe('fair');
		expect(badge().textContent?.trim()).toBe('81 ms');
	});

	it('renders yellow at the fair ceiling (150 ms)', () => {
		render(RelayRttIndicator, { props: { rtt: 150 } });
		expect(badge().getAttribute('data-rtt-tier')).toBe('fair');
	});

	it('renders red just above the fair ceiling (151 ms)', () => {
		render(RelayRttIndicator, { props: { rtt: 151 } });
		expect(badge().getAttribute('data-rtt-tier')).toBe('weak');
		expect(badge().textContent?.trim()).toBe('151 ms');
	});

	it('renders red for a high rtt (300 ms)', () => {
		render(RelayRttIndicator, { props: { rtt: 300 } });
		expect(badge().getAttribute('data-rtt-tier')).toBe('weak');
	});

	it('renders the neutral placeholder when rtt is undefined', () => {
		render(RelayRttIndicator, { props: {} });
		expect(badge().getAttribute('data-rtt-tier')).toBe('unknown');
		expect(badge().textContent?.trim()).toBe('\u2014');
	});

	it('treats a non-finite rtt as the neutral state', () => {
		render(RelayRttIndicator, { props: { rtt: Number.NaN } });
		expect(badge().getAttribute('data-rtt-tier')).toBe('unknown');
		expect(badge().textContent?.trim()).toBe('\u2014');
	});
});

/**
 * Task 19 — extends the Task 12 threshold suite with the contracts that the
 * integer-only specs above cannot exercise: the indicator classifies on the
 * RAW (possibly fractional) value but DISPLAYS a rounded integer, treats a
 * genuine `0 ms` reading as a valid measurement (not the absent/neutral state),
 * and keeps its visible text, `aria-label`, and `title` in lockstep. These are
 * new behaviours, not a re-statement of the green/yellow/red/neutral mapping.
 */
describe('RelayRttIndicator — rounding, boundaries & a11y (Task 19)', () => {
	it('rounds a noisy float to a clean integer label while staying green', () => {
		render(RelayRttIndicator, { props: { rtt: 71.354 } });
		expect(badge().getAttribute('data-rtt-tier')).toBe('good');
		expect(badge().textContent?.trim()).toBe('71 ms');
	});

	it('classifies on the raw value but rounds the displayed number (80.4 ms → fair, "80 ms")', () => {
		// 80.4 > RTT_GOOD_MAX (80) so the tier is fair, yet Math.round drops it
		// back to a displayed "80 ms" — proves thresholds run on the raw value
		// and the label is purely cosmetic rounding.
		render(RelayRttIndicator, { props: { rtt: 80.4 } });
		expect(badge().getAttribute('data-rtt-tier')).toBe('fair');
		expect(badge().textContent?.trim()).toBe('80 ms');
	});

	it('treats 0 ms as a valid good reading, not the missing/neutral state', () => {
		// 0 is falsy but finite — the guard is `!Number.isFinite(rtt)`, so a real
		// 0 ms measurement must render green "0 ms", never the em-dash placeholder.
		render(RelayRttIndicator, { props: { rtt: 0 } });
		expect(badge().getAttribute('data-rtt-tier')).toBe('good');
		expect(badge().textContent?.trim()).toBe('0 ms');
	});

	it('mirrors the visible label into both aria-label and title', () => {
		render(RelayRttIndicator, { props: { rtt: 123 } });
		const el = badge();
		const text = el.textContent?.trim();
		expect(text).toBe('123 ms');
		expect(el.getAttribute('aria-label')).toBe(text);
		expect(el.getAttribute('title')).toBe(text);
	});

	it('exposes the neutral placeholder through aria-label/title when rtt is absent', () => {
		render(RelayRttIndicator, { props: {} });
		const el = badge();
		expect(el.getAttribute('aria-label')).toBe('\u2014');
		expect(el.getAttribute('title')).toBe('\u2014');
	});
});
