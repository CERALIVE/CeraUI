/**
 * Reactive config-source harness for PreviewCanvas.test.ts.
 *
 * A plain `vi.fn` mock of `getConfig()` cannot drive Svelte reactivity across the
 * `$effect` boundary — the component's applied-source follow effect only re-runs
 * when it reads a genuine `$state`. This compiled rune module owns that `$state`
 * and exposes it through `getHarnessConfig()`, so the mocked `getConfig()` can
 * delegate here and a `setHarnessSource(...)` call re-runs the effect exactly like
 * a real `config` broadcast would.
 */
let source = $state<string | undefined>(undefined);

export function setHarnessSource(next: string | undefined): void {
	source = next;
}

export function getHarnessConfig(): { source?: string } {
	return { source };
}

export function resetHarnessConfig(): void {
	source = undefined;
}
