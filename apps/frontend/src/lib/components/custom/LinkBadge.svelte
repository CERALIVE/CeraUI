<script lang="ts">
/**
 * ONE compact badge for "this is bonded link N, it is <name>, of kind <type>,
 * and its radio reads <strength>".
 *
 * The Bonded Links panel and the HUD strip both answered that question, each
 * with its own inline copy of the ordinal chip, the identity colour and the
 * indicator call — so the two could (and did) drift about which glyph a link
 * gets. They now compose this, and a change to the badge reaches both.
 *
 * It renders its parts as SIBLINGS, with no wrapper element: every mount site
 * is a flex row whose gap and alignment already govern these boxes, and a
 * wrapper would either take that layout over or need `display: contents` to
 * pretend it had not.
 *
 * TWO variants, because the surfaces genuinely differ and one of those
 * differences is a documented product decision rather than drift:
 *
 *  - `row` — the Network panel's row: ordinal, glyph, name, and the kind /
 *    disambiguation line beneath it;
 *  - `compact` — the persistent HUD strip: ordinal and glyph only. The strip's
 *    four-fact scope is deliberate (root AGENTS.md → HUD 4-fact scope), so this
 *    variant must NOT grow a name or a kind label.
 *
 * Typography stays per-variant for the same reason — the strip sets its ordinal
 * in the mono face at its own size. What is shared is the STRUCTURE, the
 * identity colour, and above all the glyph, which is the thing that was
 * inconsistent.
 */
import type { LinkSignal } from '$lib/types/hud';
import { cn } from '$lib/utils';

import LinkIndicator from './LinkIndicator.svelte';

interface Props {
	link: LinkSignal;
	variant?: 'row' | 'compact';
	/** Resolved kind label ("LTE", "Wi-Fi", …). `row` variant only. */
	typeLabel?: string | undefined;
	/** Twin discriminator, rendered only for a label more than one row shares. */
	identity?: string | undefined;
}

const {
	link,
	variant = 'row',
	typeLabel = undefined,
	identity = undefined,
}: Props = $props();

const color = $derived(`var(--link-${link.linkIndex + 1})`);
</script>

<span
	class={cn(
		'shrink-0',
		variant === 'row'
			? 'text-xs font-bold tabular-nums'
			: 'font-mono text-[0.7rem] leading-none',
	)}
	style:color
	data-testid="link-badge-ordinal"
	data-link-badge-variant={variant}>L{link.linkIndex + 1}</span
>
<LinkIndicator
	shape="bars"
	size={variant === 'row' ? 'md' : 'sm'}
	type={link.type}
	signal={link.signal}
	signalTier={link.signalTier}
	connectionState={link.connectionState}
	linkIndex={link.linkIndex}
/>
{#if variant === 'row'}
	<!-- A REAL BASIS, not `flex-1`'s zero. Every instrument to the right is
	     `shrink-0`, so a zero-basis identity column is the only thing in the row
	     that can absorb a squeeze — and at 375px it absorbed all of it and
	     measured 0. With a basis the instruments wrap to a second line instead,
	     and the device name keeps its width. Written as ONE `flex` shorthand on
	     purpose: `flex-1 basis-32` sets `flex-basis` twice and which one wins is
	     decided by Tailwind's stylesheet order, not by the class attribute. -->
	<div class="flex min-w-0 flex-[1_1_8rem] flex-col leading-tight">
		<span class="truncate text-xs font-medium" data-testid="link-badge-label"
			>{link.label}</span
		>
		<span class="text-muted-foreground truncate text-[10px] uppercase tracking-wide">
			{typeLabel}{#if identity}<!--
			-->&nbsp;·&nbsp;<!--
			--><span data-testid="bonded-link-identity" dir="ltr" class="font-mono normal-case"
					>{identity}</span
				>{/if}
		</span>
	</div>
{/if}
