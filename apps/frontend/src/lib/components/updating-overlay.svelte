<style>
/* Custom animations for this component */
@keyframes shimmer {
	0% {
		background-position: -200% 0;
	}
	100% {
		background-position: 200% 0;
	}
}
</style>

<script lang="ts">
import { CheckCircle2, Cog, Download, Package, RotateCw } from '@lucide/svelte';
import { onMount } from 'svelte';
import { toast } from 'svelte-sonner';
import { LL } from '@ceraui/i18n/svelte';

import * as Drawer from '$lib/components/ui/drawer/index.js';
import { Progress } from '$lib/components/ui/progress';
import type { StatusMessage } from '$lib/types/socket-messages';

const { details }: { details: Exclude<StatusMessage['updating'], boolean | null> } = $props();

// Enhanced state management
let isVisible = $state(false);
let hasShownSuccess = $state(false);
let animationPhase = $state<'downloading' | 'unpacking' | 'installing' | 'complete'>('downloading');

// Safe progress calculation with null checks and NaN prevention
const progress: number = $derived.by(() => {
	if (!details) return 0;
	const downloading = Number(details.downloading) || 0;
	const unpacking = Number(details.unpacking) || 0;
	const setting_up = Number(details.setting_up) || 0;
	const total = downloading + unpacking + setting_up;
	return isFinite(total) ? total : 0;
});

// Safe total calculation with minimum value and NaN prevention
const total: number = $derived.by(() => {
	if (!details?.total) return 1;
	const calculatedTotal = 3 * (Number(details.total) || 0);
	const safeTotal = Math.max(calculatedTotal, 1);
	return isFinite(safeTotal) ? safeTotal : 1;
});

// Progress percentage with enhanced NaN prevention
const progressPercentage = $derived.by(() => {
	if (!details || total <= 0 || !isFinite(progress) || !isFinite(total)) {
		return 0;
	}
	const percentage = (progress / total) * 100;
	return isFinite(percentage) ? Math.min(percentage, 100) : 0;
});

// Determine current animation phase
$effect(() => {
	if (!details) return;

	if (details.downloading && details.downloading > 0) {
		animationPhase = 'downloading';
	} else if (details.unpacking && details.unpacking > 0) {
		animationPhase = 'unpacking';
	} else if (details.setting_up && details.setting_up > 0) {
		animationPhase = 'installing';
	} else if (progress >= total && total > 0) {
		animationPhase = 'complete';
	}
});

// Enhanced completion detection
const isComplete = $derived(details?.result !== undefined || (total > 1 && progress >= total));

$effect(() => {
	if (isComplete && !hasShownSuccess) {
		hasShownSuccess = true;
		setTimeout(() => {
			toast.success($LL.updatingOverlay.successMessage(), {
				description: $LL.updatingOverlay.successDescription(),
			});
		}, 500);
	}
});

// Entrance animation
onMount(() => {
	setTimeout(() => (isVisible = true), 100);
});
</script>

<!-- Enhanced Modern Glassmorphism Overlay -->
{#if isFinite(progress) && isFinite(total) && isFinite(progressPercentage)}
	<Drawer.Root closeOnEscape={false} closeOnOutsideClick={false} open={true}>
		<Drawer.Content
			class="from-background/95 via-background/90 to-background/95 h-full w-full border-0 bg-gradient-to-br backdrop-blur-xl"
			data-vaul-no-drag
			disableDrag={true}
		>
			<!-- Animated Background Pattern -->
			<div class="pointer-events-none absolute inset-0 overflow-hidden">
				<div
					class="bg-primary/5 absolute -top-1/2 -left-1/2 h-96 w-96 animate-pulse rounded-full blur-3xl"
				></div>
				<div
					style:animation-delay="1s"
					class="bg-secondary/5 absolute -right-1/2 -bottom-1/2 h-96 w-96 animate-pulse rounded-full blur-3xl"
				></div>
			</div>

			<!-- Main Content Container -->
			<div class="relative flex h-full w-full flex-col items-center justify-center p-4 sm:p-8">
				<!-- Header Section with Enhanced Typography -->
				<div
					class="mx-auto mb-4 max-w-2xl space-y-2 text-center sm:mb-8 sm:space-y-4"
					class:nav-entrance={isVisible}
				>
					<!-- Main Title with Gradient -->
					<h1
						class="from-foreground via-primary to-foreground bg-gradient-to-r bg-clip-text text-xl font-bold text-transparent sm:text-3xl md:text-4xl"
					>
						<span class="loading-pulse">{$LL.updatingOverlay.title()}</span>
					</h1>

					<!-- Subtitle with Better Typography -->
					<p class="text-muted-foreground text-sm leading-relaxed sm:text-lg">
						{$LL.updatingOverlay.description()}
					</p>

					<!-- Enhanced Status Badge -->
					<div
						class="bg-primary/10 border-primary/20 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 backdrop-blur-sm sm:px-5 sm:py-2.5"
					>
						<div class="flex items-center gap-1 sm:gap-2">
							{#if animationPhase === 'downloading'}
								<Download class="text-primary h-4 w-4 animate-bounce sm:h-5 sm:w-5" />
								<span class="text-primary text-sm font-medium sm:text-base"
									>{$LL.updatingOverlay.downloading()}</span
								>
							{:else if animationPhase === 'unpacking'}
								<Package class="h-4 w-4 animate-pulse text-amber-500 sm:h-5 sm:w-5" />
								<span class="text-sm font-medium text-amber-500 sm:text-base"
									>{$LL.updatingOverlay.unpacking()}</span
								>
							{:else if animationPhase === 'installing'}
								<Cog class="h-4 w-4 animate-spin text-blue-500 sm:h-5 sm:w-5" />
								<span class="text-sm font-medium text-blue-500 sm:text-base"
									>{$LL.updatingOverlay.installing()}</span
								>
							{:else if animationPhase === 'complete'}
								<CheckCircle2 class="h-4 w-4 text-green-500 sm:h-5 sm:w-5" />
								<span class="text-sm font-medium text-green-500 sm:text-base"
									>{$LL.updatingOverlay.successMessage()}</span
								>
							{/if}
						</div>
					</div>
				</div>

				<!-- Enhanced Progress Section -->
				<div class="mx-auto w-full max-w-lg space-y-3 sm:space-y-6">
					<!-- Spinning Update Icon -->
					<div class="flex flex-col items-center justify-center">
						<div class="relative mb-4 sm:mb-6">
							{#if animationPhase === 'complete'}
								<CheckCircle2 class="h-32 w-32 text-green-500 sm:h-40 sm:w-40" />
							{:else}
								<RotateCw class="text-primary h-32 w-32 animate-spin sm:h-40 sm:w-40" />
							{/if}

							<!-- Percentage Overlay -->
							<div class="absolute inset-0 flex items-center justify-center">
								<span
									class="text-foreground bg-background/80 rounded-full px-3 py-1.5 text-xl font-bold sm:text-2xl"
								>
									{isFinite(progressPercentage) ? progressPercentage.toFixed(0) : '0'}%
								</span>
							</div>
						</div>

						<!-- Progress Label -->
						<div class="text-muted-foreground text-sm sm:text-base">
							{$LL.updatingOverlay.progress()}
						</div>
					</div>

					<!-- Linear Progress Bar -->
					<div class="space-y-2 px-4 sm:px-0">
						<div
							class="bg-muted/30 border-border/50 h-2.5 overflow-hidden rounded-full border backdrop-blur-sm"
						>
							<Progress
								class="h-full rounded-full"
								max={isFinite(total) ? total : 1}
								value={isFinite(progress) ? progress : 0}
							/>
						</div>

						<!-- Progress Details -->
						<div class="text-muted-foreground flex justify-between text-xs sm:text-sm">
							<span
								>{isFinite(progress) ? progress : 0}
								{$LL.updatingOverlay.of()}
								{isFinite(total) ? total : 1}
								{$LL.updatingOverlay.steps()}</span
							>
							<span>{isFinite(progressPercentage) ? progressPercentage.toFixed(1) : '0.0'}%</span>
						</div>
					</div>
				</div>

				<!-- Enhanced Step Indicators -->
				<div class="mx-auto mt-4 flex max-w-md items-center justify-center gap-2 sm:mt-8 sm:gap-6">
					<!-- Download Step -->
					<div
						class="flex flex-col items-center gap-1 transition-all duration-300 sm:gap-2"
						class:opacity-100={details?.downloading > 0 || animationPhase === 'downloading'}
						class:opacity-40={!(details?.downloading > 0 || animationPhase === 'downloading')}
					>
						<div
							class="flex h-8 w-8 items-center justify-center rounded-full border-2 transition-all duration-300 sm:h-12 sm:w-12"
							class:bg-primary={details?.downloading > 0}
							class:border-muted={!(details?.downloading > 0)}
							class:border-primary={details?.downloading > 0}
							class:text-muted-foreground={!(details?.downloading > 0)}
							class:text-primary-foreground={details?.downloading > 0}
						>
							<Download
								class={`h-3 w-3 sm:h-5 sm:w-5 ${details?.downloading > 0 ? 'animate-bounce' : ''}`}
							/>
						</div>
						<span
							class="text-center text-[10px] font-medium sm:text-xs"
							class:text-primary={details?.downloading > 0}
						>
							{$LL.updatingOverlay.downloading()}
						</span>
						{#if details?.downloading > 0}
							<span class="text-muted-foreground text-[9px] sm:text-xs"
								>{details.downloading}/{details.total}</span
							>
						{/if}
					</div>

					<!-- Arrow -->
					<div class="border-muted-foreground/30 w-3 border-t-2 border-dashed sm:w-6"></div>

					<!-- Unpack Step -->
					<div
						class="flex flex-col items-center gap-1 transition-all duration-300 sm:gap-2"
						class:opacity-100={details?.unpacking > 0 || animationPhase === 'unpacking'}
						class:opacity-40={!(details?.unpacking > 0 || animationPhase === 'unpacking')}
					>
						<div
							class="flex h-8 w-8 items-center justify-center rounded-full border-2 transition-all duration-300 sm:h-12 sm:w-12"
							class:bg-amber-500={details?.unpacking > 0}
							class:border-amber-500={details?.unpacking > 0}
							class:border-muted={!(details?.unpacking > 0)}
							class:text-muted-foreground={!(details?.unpacking > 0)}
							class:text-white={details?.unpacking > 0}
						>
							<Package
								class={`h-3 w-3 sm:h-5 sm:w-5 ${details?.unpacking > 0 ? 'animate-pulse' : ''}`}
							/>
						</div>
						<span
							class="text-center text-[10px] font-medium sm:text-xs"
							class:text-amber-500={details?.unpacking > 0}
						>
							{$LL.updatingOverlay.unpacking()}
						</span>
						{#if details?.unpacking > 0}
							<span class="text-muted-foreground text-[9px] sm:text-xs"
								>{details.unpacking}/{details.total}</span
							>
						{/if}
					</div>

					<!-- Arrow -->
					<div class="border-muted-foreground/30 w-3 border-t-2 border-dashed sm:w-6"></div>

					<!-- Install Step -->
					<div
						class="flex flex-col items-center gap-1 transition-all duration-300 sm:gap-2"
						class:opacity-100={details?.setting_up > 0 || animationPhase === 'installing'}
						class:opacity-40={!(details?.setting_up > 0 || animationPhase === 'installing')}
					>
						<div
							class="flex h-8 w-8 items-center justify-center rounded-full border-2 transition-all duration-300 sm:h-12 sm:w-12"
							class:bg-blue-500={details?.setting_up > 0}
							class:border-blue-500={details?.setting_up > 0}
							class:border-muted={!(details?.setting_up > 0)}
							class:text-muted-foreground={!(details?.setting_up > 0)}
							class:text-white={details?.setting_up > 0}
						>
							<Cog
								class={`h-3 w-3 sm:h-5 sm:w-5 ${details?.setting_up > 0 ? 'animate-spin' : ''}`}
							/>
						</div>
						<span
							class="text-center text-[10px] font-medium sm:text-xs"
							class:text-blue-500={details?.setting_up > 0}
						>
							{$LL.updatingOverlay.installing()}
						</span>
						{#if details?.setting_up > 0}
							<span class="text-muted-foreground text-[9px] sm:text-xs"
								>{details.setting_up}/{details.total}</span
							>
						{/if}
					</div>
				</div>
			</div>
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<!-- Fallback overlay without animations if values are invalid -->
	<div class="bg-background/95 fixed inset-0 z-50 backdrop-blur-xl">
		<div class="relative flex h-full w-full flex-col items-center justify-center p-4 sm:p-8">
			<div class="text-center">
				<RotateCw class="text-primary mx-auto mb-4 h-32 w-32 animate-spin" />
				<div class="text-muted-foreground text-sm">Loading...</div>
			</div>
		</div>
	</div>
{/if}
