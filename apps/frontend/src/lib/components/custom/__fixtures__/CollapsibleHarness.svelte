<script lang="ts">
// Test-only fixture: `CollapsibleSection`'s `children` is a required Snippet, so
// a plain `render(Component, {props})` cannot supply one. This mounts the REAL
// component with real content, so the assertions read the shipped markup rather
// than a re-declaration of it.
import CollapsibleSection from '../CollapsibleSection.svelte';

interface Props {
	open?: boolean;
	title: string;
	bodyId?: string;
	testid?: string;
	toggleTestid?: string;
	bodyTestid?: string;
}

let {
	open = $bindable(false),
	title,
	bodyId,
	testid,
	toggleTestid,
	bodyTestid,
}: Props = $props();
</script>

<CollapsibleSection
	{bodyId}
	{bodyTestid}
	{testid}
	{title}
	{toggleTestid}
	bind:open
>
	<button type="button" data-testid="harness-inner-control">body content</button>
</CollapsibleSection>
