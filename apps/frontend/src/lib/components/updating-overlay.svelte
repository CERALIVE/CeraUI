<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { StatusMessage } from '@ceraui/rpc/schemas';
import { CheckCircle2, Cog, Download, Package, RotateCw, XCircle } from '@lucide/svelte';
import { onMount } from 'svelte';

import * as Drawer from '$lib/components/ui/drawer/index.js';
import { Progress } from '$lib/components/ui/progress';
import { announceLegacyInstallOutcome } from '$lib/updates/legacy-install-notice';
import { packageProgressFraction } from '$lib/updates/package-progress';

const { details }: { details: Exclude<StatusMessage['updating'], boolean | null> } = $props();

// Enhanced state management
let isVisible = $state(false);

// Truthful terminal-state detection. `details.result` is `0` (the device's
// success result) or a STRING (the apt failure message the update loop
// broadcasts before clearing state). Only the device's result decides: the
// progress counters reach their totals before apt has exited, so a run that is
// still finishing, or about to fail, must not be called a success, and a
// premature success would latch and swallow the real failure (sweep C3).
const failureReason = $derived(
	typeof details?.result === 'string' ? details.result : undefined,
);
const isFailure = $derived(failureReason !== undefined);
const isSuccess = $derived(details?.result === 0);

const animationPhase = $derived.by(() => {
	if (isFailure) return 'failed';
	if (isSuccess) return 'complete';
	if (details.setting_up > 0) return 'installing';
	if (details.unpacking > 0) return 'unpacking';
	return details.downloading > 0 ? 'downloading' : 'preparing';
});

// APT's Get:N reports a fetch starting, not bytes or packages completed.
const downloadFinished = $derived(
	animationPhase === 'unpacking' || animationPhase === 'installing' || isSuccess,
);
const fraction = $derived(downloadFinished ? packageProgressFraction(details, isSuccess) : null);

// Terminal outcomes have ONE announcer, once per outcome. In the app Layout
// never mounts this takeover for a terminal frame: it releases the takeover and
// announces there; this call covers the overlay rendered on its own.
$effect(() => {
	announceLegacyInstallOutcome(details);
});

// Entrance animation
onMount(() => {
	setTimeout(() => (isVisible = true), 100);
});
</script>

<!-- Enhanced Modern Glassmorphism Overlay -->
{#if details}
	<Drawer.Root closeOnEscape={false} closeOnOutsideClick={false} open={true}>
		<Drawer.Content
			class="from-background/95 via-background/90 to-background/95 h-full w-full border-0 bg-gradient-to-br backdrop-blur-xl"
			data-testid="updating-overlay"
			data-vaul-no-drag
			disableDrag={true}
		>
			<!-- Main Content Container -->
			<div class="relative flex h-full w-full flex-col items-center justify-center p-4 sm:p-8">
				<!-- Header Section with Enhanced Typography -->
				<div
					class="mx-auto mb-4 max-w-2xl space-y-2 text-center sm:mb-8 sm:space-y-4"
					class:nav-entrance={isVisible}
				>
					<h1 class="text-foreground text-xl font-bold sm:text-3xl md:text-4xl">
						{m["updatingOverlay.title"]()}
					</h1>

					<!-- Subtitle with Better Typography -->
					<p class="text-muted-foreground text-sm leading-relaxed sm:text-lg">
						{m["updatingOverlay.description"]()}
					</p>

					<!-- Status register: one chip, one phase word, one glyph, all static.
					     Motion is carried once — by the progress ring below — so the phase
					     an operator reads is never itself in motion. -->
					<div
						class="bg-primary/10 border-primary/20 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 sm:px-5 sm:py-2.5"
						data-testid="update-phase"
					>
						<div class="flex items-center gap-1 sm:gap-2">
							{#if animationPhase === 'preparing' || animationPhase === 'downloading'}
								<Download class="text-primary h-4 w-4 sm:h-5 sm:w-5" />
								<span class="text-primary text-sm font-medium sm:text-base"
									>{animationPhase === 'preparing'
										? m["updatingOverlay.preparingOrDownloading"]()
										: m["updatingOverlay.downloading"]()}</span
								>
							{:else if animationPhase === 'unpacking'}
								<Package class="h-4 w-4 text-status-warning sm:h-5 sm:w-5" />
								<span class="text-sm font-medium text-status-warning sm:text-base"
									>{m["updatingOverlay.unpacking"]()}</span
								>
							{:else if animationPhase === 'installing'}
								<Cog class="h-4 w-4 text-status-info sm:h-5 sm:w-5" />
								<span class="text-sm font-medium text-status-info sm:text-base"
									>{m["updatingOverlay.installing"]()}</span
								>
							{:else if animationPhase === 'complete'}
								<CheckCircle2 class="h-4 w-4 text-status-success sm:h-5 sm:w-5" />
								<span class="text-sm font-medium text-status-success sm:text-base"
									>{m["updatingOverlay.successMessage"]()}</span
								>
							{:else if animationPhase === 'failed'}
								<XCircle class="h-4 w-4 text-status-error sm:h-5 sm:w-5" />
								<span class="text-sm font-medium text-status-error sm:text-base"
									>{m["updatingOverlay.failedMessage"]()}</span
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
							{#if animationPhase === 'failed'}
								<XCircle class="h-32 w-32 text-status-error sm:h-40 sm:w-40" />
							{:else if animationPhase === 'complete'}
								<CheckCircle2 class="h-32 w-32 text-status-success sm:h-40 sm:w-40" />
							{:else}
								<RotateCw
									class="text-primary h-32 w-32 motion-safe:animate-spin sm:h-40 sm:w-40"
								/>
							{/if}

							<!-- Percentage Overlay -->
							{#if fraction}
								<div class="absolute inset-0 flex items-center justify-center">
									<span
										class="text-foreground bg-background/80 rounded-full px-3 py-1.5 text-xl font-bold sm:text-2xl"
									>
										{fraction.percent}%
									</span>
								</div>
							{/if}
						</div>

						{#if animationPhase === 'failed'}
							<!-- Failure indicator -->
							<div
								class="flex flex-col items-center gap-1 text-center"
								data-testid="update-failed"
							>
								<div class="text-sm font-medium text-status-error sm:text-base">
									{m["updatingOverlay.failedMessage"]()}
								</div>
								<div
									class="text-muted-foreground max-w-md text-xs break-words sm:text-sm"
									data-testid="update-failed-reason"
								>
									{failureReason ?? m["updatingOverlay.failedDescription"]()}
								</div>
							</div>
						{:else}
							<!-- Progress Label -->
							<div class="text-muted-foreground text-sm sm:text-base">
								{m["updatingOverlay.progress"]()}
							</div>
						{/if}
					</div>

					<!-- Linear Progress Bar -->
					<div class="space-y-2 px-4 sm:px-0">
						<div
							class="bg-muted/30 border-border/50 h-2.5 overflow-hidden rounded-full border backdrop-blur-sm"
						>
							<Progress
								class="package-update-progress h-full rounded-full"
								max={fraction?.total ?? 1}
								value={fraction?.completed ?? null}
								aria-valuetext={fraction ? `${fraction.percent}%` : undefined}
								aria-label={m["updatingOverlay.progress"]()}
							/>
						</div>

						<!-- Progress Details -->
						{#if fraction}
							<div class="text-muted-foreground flex justify-between text-xs sm:text-sm">
								<span
									>{fraction.completed}
									{m["updatingOverlay.of"]()}
									{fraction.total}
									{m["updatingOverlay.steps"]()}</span
								>
								<span>{fraction.percent}%</span>
							</div>
						{/if}
					</div>
				</div>

				<!-- Enhanced Step Indicators -->
				<div class="mx-auto mt-4 flex max-w-md items-center justify-center gap-2 sm:mt-8 sm:gap-6">
					<!-- Download Step -->
					<div
						class="flex flex-col items-center gap-1 transition-all duration-300 sm:gap-2"
						class:opacity-100={!isFailure || details.downloading > 0}
						class:opacity-40={isFailure && details.downloading <= 0}
					>
						<div
							class="flex h-8 w-8 items-center justify-center rounded-full border-2 transition-all duration-300 sm:h-12 sm:w-12"
							class:bg-primary={downloadFinished}
							class:border-muted={!downloadFinished}
							class:border-primary={downloadFinished}
							class:text-muted-foreground={!downloadFinished}
							class:text-primary-foreground={downloadFinished}
						>
							<Download class="h-3 w-3 sm:h-5 sm:w-5" />
						</div>
						<span
							class="text-center text-[10px] font-medium sm:text-xs"
							class:text-primary={downloadFinished}
						>
							{m["updatingOverlay.downloading"]()}
						</span>
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
							class:bg-status-warning={details?.unpacking > 0}
							class:border-status-warning={details?.unpacking > 0}
							class:border-muted={!(details?.unpacking > 0)}
							class:text-muted-foreground={!(details?.unpacking > 0)}
							class:text-white={details?.unpacking > 0}
						>
							<Package class="h-3 w-3 sm:h-5 sm:w-5" />
						</div>
						<span
							class="text-center text-[10px] font-medium sm:text-xs"
							class:text-status-warning={details?.unpacking > 0}
						>
							{m["updatingOverlay.unpacking"]()}
						</span>
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
							class:bg-status-info={details?.setting_up > 0}
							class:border-status-info={details?.setting_up > 0}
							class:border-muted={!(details?.setting_up > 0)}
							class:text-muted-foreground={!(details?.setting_up > 0)}
							class:text-white={details?.setting_up > 0}
						>
							<Cog class="h-3 w-3 sm:h-5 sm:w-5" />
						</div>
						<span
							class="text-center text-[10px] font-medium sm:text-xs"
							class:text-status-info={details?.setting_up > 0}
						>
							{m["updatingOverlay.installing"]()}
						</span>
					</div>
				</div>
			</div>
		</Drawer.Content>
	</Drawer.Root>
{/if}
