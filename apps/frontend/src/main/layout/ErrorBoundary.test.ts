// @vitest-environment jsdom
/**
 * Behavioral test — Task 30: top-level error boundary with recoverable fallback.
 *
 * The app shell is wrapped in ONE <svelte:boundary> (App.svelte → ErrorBoundary).
 * When any descendant throws during render, the operator must see a recoverable
 * fallback card — NOT a blank app — and the error must be logged, not swallowed.
 *
 * These fixtures mirror the real wiring (ErrorBoundary wrapping a child) so the
 * assertions exercise the same boundary + fallback the app ships with.
 */
import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import BoundaryHarness from './__fixtures__/BoundaryHarness.svelte';
import SafeHarness from './__fixtures__/SafeHarness.svelte';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('ErrorBoundary — top-level recoverable fallback (Task 30)', () => {
	it('renders the fallback (not a blank app) when a child throws on render', () => {
		// Silence the boundary's console.error so the run stays clean.
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const { queryByText, queryByRole } = render(BoundaryHarness);

		// Fallback title is queryable — the app did not blank out.
		expect(queryByText('Something went wrong')).not.toBeNull();

		// The fallback is a live alert region with a recovery affordance, proving
		// real UI rendered rather than an empty document.
		expect(queryByRole('alert')).not.toBeNull();
		expect(queryByRole('button', { name: 'Try again' })).not.toBeNull();
	});

	it('logs the error instead of swallowing it', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		render(BoundaryHarness);

		expect(errorSpy).toHaveBeenCalled();
		// The thrown error object is forwarded to the handler (not a bare string).
		const loggedAnError = errorSpy.mock.calls.some((args) =>
			args.some((arg) => arg instanceof Error),
		);
		expect(loggedAnError).toBe(true);
	});

	it('is transparent on the happy path — renders children, no fallback', () => {
		const { queryByTestId, queryByText } = render(SafeHarness);

		// Child content renders through the boundary untouched...
		expect(queryByTestId('safe-child')?.textContent).toBe('All systems nominal');
		// ...and the fallback is absent.
		expect(queryByText('Something went wrong')).toBeNull();
	});
});
