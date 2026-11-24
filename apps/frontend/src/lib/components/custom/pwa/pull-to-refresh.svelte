<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { RefreshCw } from '@lucide/svelte';
import { onMount } from 'svelte';

interface Props {
	onRefresh: () => Promise<void> | void;
	threshold?: number;
	distance?: number;
	children: import('svelte').Snippet;
}

const { onRefresh, threshold = 80, distance = 150, children }: Props = $props();

let refreshElement: HTMLElement;
let isRefreshing = $state(false);
let pullDistance = $state(0);
let canRefresh = $state(false);

let pull: { id: number; y: number } | undefined;

function resetPull() {
	pull = undefined;
	canRefresh = false;
	pullDistance = 0;
	if (refreshElement) {
		refreshElement.style.transform = 'translateY(-48px)';
		refreshElement.style.opacity = '0';
		refreshElement.style.pointerEvents = 'none';
		refreshElement.style.cursor = 'default';
	}
}

const handleTouchStart = (e: TouchEvent) => {
	// A second contact cancels ownership, even if it starts outside the marked
	// list. Its remaining finger cannot arm a refresh until a new gesture.
	if (e.touches.length !== 1) {
		if (pull) resetPull();
		return;
	}
	if (isRefreshing || window.scrollY > 0) return;
	// Let marked regions own the entire gesture, even at their scroll boundaries.
	if (e.composedPath().some(
		(node) => node instanceof Element && node.hasAttribute('data-no-pull-to-refresh'),
	)) {
		return;
	}

	const touch = e.touches[0];
	if (!touch || !Number.isFinite(touch.clientY)) return;
	pull = { id: touch.identifier, y: touch.clientY };
};

const handleTouchMove = (e: TouchEvent) => {
	if (!pull) return;
	const touch = e.touches[0];
	if (e.touches.length !== 1 || touch?.identifier !== pull.id || window.scrollY > 0) {
		resetPull();
		return;
	}
	if (!Number.isFinite(touch.clientY)) return;
	const rawPullDistance = touch.clientY - pull.y;
	pullDistance = Number.isFinite(rawPullDistance) ? Math.max(0, rawPullDistance) : 0;

	canRefresh = pullDistance > threshold;

	// Prevent default scrolling when pulling
	if (pullDistance > 0) {
		e.preventDefault();
	}

	// Apply transform with resistance (from -48px hidden to 0px visible) - NaN safe
	const safePullDistance = Number.isFinite(pullDistance) ? pullDistance : 0;
	const safeThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 80;
	const safeDistance = Number.isFinite(distance) ? distance : 150;

	const resistance = Math.min(safePullDistance / 2, safeDistance);
	const safeResistance = Number.isFinite(resistance) ? resistance : 0;

	const transformCalculation = -48 + Math.min((safeResistance * 48) / safeThreshold, 48);
	const transformY = Number.isFinite(transformCalculation) ? transformCalculation : -48;

	const opacityCalculation = Math.min(safePullDistance / safeThreshold, 1);
	const opacity = Number.isFinite(opacityCalculation) ? opacityCalculation : 0;

	if (refreshElement) {
		refreshElement.style.transform = `translateY(${transformY}px)`;
		refreshElement.style.opacity = opacity.toString();
		// Enable pointer events when visible and allow clicking to cancel refresh
		refreshElement.style.pointerEvents = pullDistance > threshold ? 'auto' : 'none';
		refreshElement.style.cursor = pullDistance > threshold ? 'pointer' : 'default';
	}
};

const handleTouchEnd = async (e: TouchEvent) => {
	const owner = pull;
	if (!owner || !Array.from(e.changedTouches).some((touch) => touch.identifier === owner.id)) return;
	pull = undefined;
	if (e.touches.length !== 0 || !canRefresh || isRefreshing) return resetPull();
	isRefreshing = true;
	try {
		await onRefresh();
	} catch (error) {
		console.error('Refresh error:', error);
	} finally {
		isRefreshing = false;
		resetPull();
	}
};

onMount(() => {
	// Only add touch listeners on mobile/tablet devices (including iPad) with NaN safety
	const { maxTouchPoints } = navigator;
	const hasTouchScreen =
		'ontouchstart' in window || (Number.isFinite(maxTouchPoints) && maxTouchPoints > 0);
	const userAgent = navigator.userAgent || '';
	const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
		userAgent,
	);
	const isMobile = hasTouchScreen || isMobileUA;

	if (isMobile) {
		// Add touch event listeners
		document.addEventListener('touchstart', handleTouchStart, { passive: true });
		document.addEventListener('touchmove', handleTouchMove, { passive: false });
		document.addEventListener('touchend', handleTouchEnd, { passive: true });
		document.addEventListener('touchcancel', resetPull, { passive: true });

		return () => {
			document.removeEventListener('touchstart', handleTouchStart);
			document.removeEventListener('touchmove', handleTouchMove);
			document.removeEventListener('touchend', handleTouchEnd);
			document.removeEventListener('touchcancel', resetPull);
		};
	}
});
</script>

<!-- Pull to Refresh Indicator -->
<button
	type="button"
	disabled={!isRefreshing}
	aria-hidden={!isRefreshing}
	bind:this={refreshElement}
	style:transform="translateY(-48px)"
	style:margin-top="56px"
	class="bg-background/95 supports-backdrop-filter:bg-background/80 pointer-events-none fixed top-0 right-0 left-0 z-[60] flex h-12 transform items-center justify-center border-b opacity-0 shadow-sm backdrop-blur-sm transition-all duration-300"
	onclick={() => {
		if (isRefreshing) {
			isRefreshing = false;
			resetPull();
		}
	}}
>
	<span class="text-muted-foreground flex items-center gap-2">
		<RefreshCw
			class="h-4 w-4 {isRefreshing ? 'animate-spin' : ''} {canRefresh ? 'text-primary' : ''}"
		/>
		<span class="text-sm font-medium">
			{#if isRefreshing}
				{m["pwa.refreshing"]()}
			{:else if canRefresh}
				{m["pwa.releaseToRefresh"]()}
			{:else}
				{m["pwa.pullToRefresh"]()}
			{/if}
		</span>
	</span>
</button>

<!-- Container for the main content -->
<div>
	{@render children()}
</div>
