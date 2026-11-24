<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import XIcon from '@lucide/svelte/icons/x';
import type { Snippet } from 'svelte';

import { Button } from '$lib/components/ui/button';
import * as Sheet from '$lib/components/ui/sheet';

const { children, onCloseAutoFocus }: {
	children: Snippet;
	onCloseAutoFocus: (event: Event) => void;
} = $props();
</script>

<Sheet.Content
	class="gap-0 px-4 pt-2 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] motion-reduce:animate-none"
	data-touch-region
	{onCloseAutoFocus}
	side="bottom"
	showCloseButton={false}
>
	<Sheet.Header class="flex-row items-center justify-between px-0">
		<Sheet.Title>{m["live.adjustBitrate"]()}</Sheet.Title>
		<Sheet.Close>
			{#snippet child({ props: closeProps })}
				<Button {...closeProps} aria-label={m["a11y.close"]()} class="size-11 shrink-0" size="icon" variant="ghost">
					<XIcon aria-hidden={true} />
				</Button>
			{/snippet}
		</Sheet.Close>
	</Sheet.Header>
	{@render children()}
</Sheet.Content>
