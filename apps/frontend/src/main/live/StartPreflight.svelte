<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { ChevronDown, Loader2, Play } from '@lucide/svelte';
import { tick } from 'svelte';

import { Button } from '$lib/components/ui/button';
import { publishHeight } from '$lib/layout';
import type { StartAssessment } from '$lib/streaming/assess-start';
import type { GateFix } from '$lib/streaming/go-live-readiness';
import LiveBar from './LiveBar.svelte';

interface Props {
	decision: StartAssessment['decision'];
	onStart: () => void;
	onOpenSource: () => void;
	onGoNetwork: () => void;
	onOpenAudio: () => void;
	onOpenAudioSource: () => void;
	onOpenServer: (() => void) | undefined;
}

const { decision, onStart, onOpenSource, onGoNetwork, onOpenAudio, onOpenAudioSource, onOpenServer }: Props = $props();
const id = $props.id();
const statusId = `${id}-status`;
const panelId = `${id}-panel`;
const primaryReasonId = `${id}-reason`;
const titleId = `${id}-title`;

const fixActions = $derived({
	openSource: { label: m['live.goLive.fix.openSource'](), run: navigate(onOpenSource) },
	chooseAnotherSource: { label: m['live.goLive.fix.chooseAnotherSource'](), run: navigate(onOpenSource) },
	goNetwork: { label: m['live.goLive.fix.goNetwork'](), run: navigate(onGoNetwork) },
	openServer: onOpenServer && { label: m['live.goLive.fix.openServer'](), run: onOpenServer },
	openAudio: { label: m['live.source.audioEdit'](), run: onOpenAudio },
	chooseAudioSource: { label: m['live.audioCard.title'](), run: navigate(onOpenAudioSource) },
	none: undefined,
} satisfies Record<GateFix, { label: string; run: () => void } | undefined>);

const blockers = $derived(decision.state === 'blocked' ? decision.blockers.map((blocker) => ({
	id: blocker.id,
	reason: resolveMessageKey(blocker.reasonKey),
	action: fixActions[blocker.fix],
})) : []);
const firstFix = $derived(blockers.find((blocker) => blocker.action));
const multiple = $derived(blockers.length > 1);
const ready = $derived(decision.state === 'ready');
const summary = $derived.by(() => {
	switch (decision.state) {
		case 'blocked': return multiple ? m['live.bar.blockerCount']({ count: blockers.length }) : blockers[0]?.reason;
		case 'checking': return m['live.bar.checking']();
		case 'ready': return m['live.goLive.readyTitle']();
		case 'starting': return m['live.starting']();
		case 'stopping': return m['live.stopping']();
		case 'unconfirmed': return m['live.unconfirmedStream.title']();
		case 'live': return m['hud.live']();
	}
});

let open = $state(false);
let region: HTMLDivElement | undefined = $state();
let status: HTMLElement | undefined = $state();
let review: HTMLButtonElement | null = $state(null);
let start: HTMLButtonElement | null = $state(null);
let panel: HTMLElement | undefined = $state();
let heading: HTMLHeadingElement | undefined = $state();
let list: HTMLUListElement | undefined = $state();
let visibleHeight = $state(0);
let listHeight = $state(0);

$effect(() => (panel ? publishHeight(panel, '--live-checklist-height') : undefined));

function navigate(run: () => void) {
	return () => {
		open = false;
		run();
	};
}

function focus(target: HTMLElement | null | undefined): boolean {
	target?.focus({ preventScroll: true });
	if (target == null || document.activeElement !== target) return false;
	target.scrollIntoView?.({ block: 'nearest' });
	return true;
}

export function focusStartOrPreflight(): boolean {
	const openFix = open ? list?.querySelector<HTMLButtonElement>('button') : undefined;
	if (openFix && focus(openFix)) return true;
	const inlineFix = status?.parentElement?.querySelector<HTMLButtonElement>('[data-fix-id]');
	return focus(inlineFix ?? review ?? (start?.disabled === false ? start : status));
}

// Capture ownership before the DOM update; don't steal valid focus afterward.
$effect.pre(() => {
	const ready = decision.state === 'ready';
	const ui = region;
	if (!ui) return;
	const active = document.activeElement;
	if (!multiple && open) open = false;
	if (!(active instanceof HTMLElement) || !ui.contains(active)) return;
	const disablingStart = active === start && !ready;
	void tick().then(() => {
		if (!ui.isConnected || (active.isConnected && !active.matches(':disabled'))) return;
		const now = document.activeElement;
		if (now !== document.body && !(disablingStart && now === active)) return;
		focusStartOrPreflight();
	});
});

async function toggle() {
	open = !open;
	const opening = open;
	await tick();
	focus(opening ? heading : review);
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key !== 'Escape' || !open || event.defaultPrevented ||
		!(event.target instanceof Node) || !region?.contains(event.target)) return;
	event.preventDefault();
	void toggle();
}
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet fixButton(fixId: string, descriptionId: string, action: { label: string; run: () => void }, width: string)}
	<Button
		aria-describedby={descriptionId}
		class="h-auto min-h-11 min-w-11 shrink-0 whitespace-normal {width}"
		data-fix-id={fixId}
		variant="outline"
		size="sm"
		onclick={action.run}
	>{action.label}</Button>
{/snippet}

<div bind:this={region} data-multiple-preflight={multiple ? '' : undefined}>
	<LiveBar blocked={decision.state === 'blocked'} pending={decision.state !== 'ready' && decision.state !== 'blocked'}>
		{#snippet disclosure()}
			{#if multiple && open}
				<section bind:this={panel} class="preflight-panel bg-background absolute inset-x-0 bottom-full mx-auto flex w-full max-w-3xl flex-col border-t px-4 sm:px-6 lg:max-w-6xl" id={panelId} aria-labelledby={titleId}>
					<h3 id={titleId} tabindex="-1" bind:this={heading} class="shrink-0 py-2 text-sm font-semibold outline-none focus-visible:underline">
						{m['live.bar.beforeLive']()}
					</h3>
					<div bind:clientHeight={visibleHeight} class="min-h-0 overflow-y-auto overscroll-contain px-1" data-no-pull-to-refresh>
						<ul bind:this={list} bind:offsetHeight={listHeight} aria-labelledby={titleId} class="divide-y">
							{#each blockers as blocker (blocker.id)}
								<li class="flex items-center justify-between gap-2 py-1.5">
									<p id={`${id}-${blocker.id}`} class="min-w-0 text-sm break-words text-muted-foreground">{blocker.reason}</p>
									{#if blocker.action}
										{@render fixButton(blocker.id, `${id}-${blocker.id}`, blocker.action, 'max-w-[48%]')}
									{/if}
								</li>
							{/each}
						</ul>
					</div>
					{#if listHeight > visibleHeight}
						<p class="text-muted-foreground flex shrink-0 items-center gap-1 border-t py-1 text-xs">
							<ChevronDown size={14} aria-hidden="true" />{m['live.bar.scrollForAll']()}
						</p>
					{/if}
				</section>
			{/if}
		{/snippet}
		<div class="flex min-h-11 min-w-0 items-center gap-2 sm:min-h-0 sm:flex-1">
			<span aria-hidden="true" class="size-2 shrink-0 rounded-full {decision.state === 'blocked' ? 'bg-destructive' : decision.state === 'ready' ? 'bg-status-success' : 'bg-muted-foreground'}"></span>
			<p id={statusId} tabindex="-1" bind:this={status} class="min-w-0 flex-1 break-words text-sm leading-4 focus-visible:underline">
				{summary}
			</p>
			<span role="status" class="sr-only">
				{summary}{#if multiple}: {blockers.map(({ reason }) => reason).join('; ')}{/if}
			</span>
			{#if firstFix?.action}
				<span class="sr-only" id={primaryReasonId}>{firstFix.reason}</span>
				{#key firstFix.id}
					{@render fixButton(firstFix.id, multiple ? primaryReasonId : statusId, firstFix.action, 'max-w-[44%]')}
				{/key}
			{/if}
			{#if multiple}
				<Button
					bind:ref={review}
					aria-describedby={statusId}
					aria-expanded={open}
					aria-controls={open ? panelId : undefined}
					class="h-auto min-h-11 min-w-11 max-w-[34%] shrink-0 whitespace-normal"
					data-preflight-review
					variant="ghost"
					size="sm"
					onclick={toggle}
				>
					{open ? m['a11y.close']() : m['live.bar.showAll']()}
					<ChevronDown class={open ? 'rotate-180' : ''} aria-hidden="true" />
				</Button>
			{/if}
		</div>
		<div class="shrink-0 sm:min-w-56">
			<Button
				bind:ref={start}
				class="group min-h-11 w-full gap-3 py-6 text-base font-semibold disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 [@media(max-height:640px)]:py-3"
				aria-describedby={ready ? undefined : multiple && firstFix ? primaryReasonId : statusId}
				disabled={!ready}
				onclick={() => { if (ready) onStart(); }}
				size="lg"
				title={ready ? undefined : firstFix?.reason ?? summary}
				type="button"
			>
				{#if decision.state === 'starting'}
					<Loader2 aria-hidden={true} class="h-5 w-5 animate-spin motion-reduce:animate-none" />
					{m['live.starting']()}
				{:else}
					<Play aria-hidden={true} class="h-5 w-5 transition-transform group-hover:scale-110" />
					{m['live.startStream']()}
				{/if}
			</Button>
		</div>
	</LiveBar>
</div>

<style>
	/* The header can start below the in-flow update badge before it sticks. */
	.preflight-panel {
		max-height: min(24rem, max(6rem, calc(
			100dvh - var(--live-bar-offset) - var(--live-bar-height, 0px)
			- var(--app-header-height, 57px) - var(--offline-bar-height) - var(--top-bands-height) - 0.5rem
			- var(--update-badge-height, 0px) - var(--refusal-clearance, 0px)
		)));
	}

	/* Keep room above the list for the refusal's actions and a line of copy. */
	:global(html:has(.start-refusal-toast)) .preflight-panel {
		--refusal-clearance: 7rem;
	}

	/* A multi-blocker bar, its checklist and a refusal cannot all fit above the
	   dock on a short phone. Let the document scroll them past the sticky header. */
	@media (width < 40rem) and (height <= 25rem) {
		:global(html:has([data-multiple-preflight])) {
			scroll-padding-block-start: calc(
				var(--app-header-height, 0px) + var(--offline-bar-height) + var(--top-bands-height)
			);
			scroll-padding-block-end: calc(var(--mobile-dock-height) + env(safe-area-inset-bottom, 0px));
		}

		[data-multiple-preflight] :global(.live-bar) {
			position: relative;
			inset: auto;
		}

		[data-multiple-preflight] :global(.bar-content) {
			flex-direction: column;
			align-items: stretch;
		}

		[data-multiple-preflight] .preflight-panel {
			position: static;
			max-height: none;
		}

		/* No fixed Live surfaces are in the way in this mode. */
		:global(html:has([data-multiple-preflight]) :is([data-testid='idle-cockpit'], [data-sonner-toaster])) {
			--live-bar-height: 0px;
			--live-checklist-height: 0px;
		}

		/* This is the refusal's separate Sonner stack, not the general host stack.
		   Put the same card at the end of the document; do not move or recreate its
		   actions. The trailing dock space lets its last row fully scroll clear. */
		:global(html:has([data-multiple-preflight]) [data-sonner-toaster]:has(> .start-refusal-toast)) {
			position: relative;
			inset: auto;
			width: auto;
			margin: 0 1rem calc(var(--mobile-dock-height) + env(safe-area-inset-bottom, 0px));
		}

		:global(html:has([data-multiple-preflight]) [data-sonner-toast].start-refusal-toast) {
			position: relative;
			width: 100%;
			transform: none;
			--refusal-height: none;
		}
	}
</style>
