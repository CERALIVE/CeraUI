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
import { _ } from 'svelte-i18n';
import { toast } from 'svelte-sonner';

import * as Drawer from '$lib/components/ui/drawer/index.js';
import { Progress } from '$lib/components/ui/progress';
import type { StatusMessage } from '$lib/types/socket-messages';

let { details }: { details: Exclude<StatusMessage['updating'], boolean | null> } = $props();

// Enhanced state management
let isVisible = $state(false);
let hasShownSuccess = $state(false);
let animationPhase = $state<'downloading' | 'unpacking' | 'installing' | 'complete'>('downloading');

// Safe progress calculation with null checks
let progress: number = $derived.by(() => {
  if (!details) return 0;
  const downloading = Number(details.downloading) || 0;
  const unpacking = Number(details.unpacking) || 0;
  const setting_up = Number(details.setting_up) || 0;
  return downloading + unpacking + setting_up;
});

// Safe total calculation with minimum value
let total: number = $derived(Math.max(3 * (Number(details?.total) || 0), 1));

// Progress percentage with safe division
let progressPercentage = $derived(total > 0 ? Math.min((progress / total) * 100, 100) : 0);

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
let isComplete = $derived(details?.result !== undefined || (total > 1 && progress >= total));

$effect(() => {
  if (isComplete && !hasShownSuccess) {
    hasShownSuccess = true;
    setTimeout(() => {
      toast.success($_('updatingOverlay.successMessage'), {
        description: $_('updatingOverlay.successDescription'),
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
<Drawer.Root open={true} closeOnOutsideClick={false} closeOnEscape={false}>
  <Drawer.Content
    class="from-background/95 via-background/90 to-background/95 h-full w-full border-0 bg-gradient-to-br backdrop-blur-xl"
    disableDrag={true}
    data-vaul-no-drag>
    <!-- Animated Background Pattern -->
    <div class="pointer-events-none absolute inset-0 overflow-hidden">
      <div class="bg-primary/5 absolute -top-1/2 -left-1/2 h-96 w-96 animate-pulse rounded-full blur-3xl"></div>
      <div
        class="bg-secondary/5 absolute -right-1/2 -bottom-1/2 h-96 w-96 animate-pulse rounded-full blur-3xl"
        style="animation-delay: 1s">
      </div>
    </div>

    <!-- Main Content Container -->
    <div class="relative flex h-full w-full flex-col items-center justify-center p-4 sm:p-8">
      <!-- Header Section with Enhanced Typography -->
      <div class="mx-auto mb-4 sm:mb-8 max-w-2xl space-y-2 sm:space-y-4 text-center" class:nav-entrance={isVisible}>
        <!-- Main Title with Gradient -->
        <h1
          class="from-foreground via-primary to-foreground bg-gradient-to-r bg-clip-text text-xl sm:text-3xl md:text-4xl font-bold text-transparent">
          <span class="loading-pulse">{$_('updatingOverlay.title')}</span>
        </h1>

        <!-- Subtitle with Better Typography -->
        <p class="text-muted-foreground text-sm sm:text-lg leading-relaxed">
          {$_('updatingOverlay.description')}
        </p>

        <!-- Enhanced Status Badge -->
        <div
          class="bg-primary/10 border-primary/20 inline-flex items-center gap-2 rounded-full border px-3 sm:px-5 py-1.5 sm:py-2.5 backdrop-blur-sm">
          <div class="flex items-center gap-1 sm:gap-2">
            {#if animationPhase === 'downloading'}
              <Download class="text-primary h-4 w-4 sm:h-5 sm:w-5 animate-bounce" />
              <span class="text-primary font-medium text-sm sm:text-base">{$_('updatingOverlay.downloading')}</span>
            {:else if animationPhase === 'unpacking'}
              <Package class="h-4 w-4 sm:h-5 sm:w-5 animate-pulse text-amber-500" />
              <span class="font-medium text-amber-500 text-sm sm:text-base">{$_('updatingOverlay.unpacking')}</span>
            {:else if animationPhase === 'installing'}
              <Cog class="h-4 w-4 sm:h-5 sm:w-5 animate-spin text-blue-500" />
              <span class="font-medium text-blue-500 text-sm sm:text-base">{$_('updatingOverlay.installing')}</span>
            {:else if animationPhase === 'complete'}
              <CheckCircle2 class="h-4 w-4 sm:h-5 sm:w-5 text-green-500" />
              <span class="font-medium text-green-500 text-sm sm:text-base">{$_('updatingOverlay.successMessage')}</span>
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
              <CheckCircle2 class="h-32 w-32 sm:h-40 sm:w-40 text-green-500" />
            {:else}
              <RotateCw class="h-32 w-32 sm:h-40 sm:w-40 text-primary animate-spin" />
            {/if}
            
            <!-- Percentage Overlay -->
            <div class="absolute inset-0 flex items-center justify-center">
              <span class="text-foreground text-xl sm:text-2xl font-bold bg-background/80 rounded-full px-3 py-1.5">
                {progressPercentage.toFixed(0)}%
              </span>
            </div>
          </div>
          
          <!-- Progress Label -->
          <div class="text-muted-foreground text-sm sm:text-base">
            {$_('updatingOverlay.progress')}
          </div>
        </div>

        <!-- Linear Progress Bar -->
        <div class="space-y-2 px-4 sm:px-0">
          <div class="bg-muted/30 border-border/50 h-2.5 overflow-hidden rounded-full border backdrop-blur-sm">
            <Progress value={progress} max={total} class="h-full rounded-full" />
          </div>

          <!-- Progress Details -->
          <div class="text-muted-foreground flex justify-between text-xs sm:text-sm">
            <span>{progress} {$_('updatingOverlay.of')} {total} {$_('updatingOverlay.steps')}</span>
            <span>{progressPercentage.toFixed(1)}%</span>
          </div>
        </div>
      </div>

      <!-- Enhanced Step Indicators -->
      <div class="mx-auto mt-4 sm:mt-8 flex max-w-md items-center justify-center gap-2 sm:gap-6">
        <!-- Download Step -->
        <div
          class="flex flex-col items-center gap-1 sm:gap-2 transition-all duration-300"
          class:opacity-100={details?.downloading > 0 || animationPhase === 'downloading'}
          class:opacity-40={!(details?.downloading > 0 || animationPhase === 'downloading')}>
          <div
            class="flex h-8 w-8 sm:h-12 sm:w-12 items-center justify-center rounded-full border-2 transition-all duration-300"
            class:bg-primary={details?.downloading > 0}
            class:border-primary={details?.downloading > 0}
            class:text-primary-foreground={details?.downloading > 0}
            class:border-muted={!(details?.downloading > 0)}
            class:text-muted-foreground={!(details?.downloading > 0)}>
            <Download class={`h-3 w-3 sm:h-5 sm:w-5 ${details?.downloading > 0 ? 'animate-bounce' : ''}`} />
          </div>
          <span class="text-[10px] sm:text-xs font-medium text-center" class:text-primary={details?.downloading > 0}>
            {$_('updatingOverlay.downloading')}
          </span>
          {#if details?.downloading > 0}
            <span class="text-muted-foreground text-[9px] sm:text-xs">{details.downloading}/{details.total}</span>
          {/if}
        </div>

        <!-- Arrow -->
        <div class="border-muted-foreground/30 w-3 sm:w-6 border-t-2 border-dashed"></div>

        <!-- Unpack Step -->
        <div
          class="flex flex-col items-center gap-1 sm:gap-2 transition-all duration-300"
          class:opacity-100={details?.unpacking > 0 || animationPhase === 'unpacking'}
          class:opacity-40={!(details?.unpacking > 0 || animationPhase === 'unpacking')}>
          <div
            class="flex h-8 w-8 sm:h-12 sm:w-12 items-center justify-center rounded-full border-2 transition-all duration-300"
            class:bg-amber-500={details?.unpacking > 0}
            class:border-amber-500={details?.unpacking > 0}
            class:text-white={details?.unpacking > 0}
            class:border-muted={!(details?.unpacking > 0)}
            class:text-muted-foreground={!(details?.unpacking > 0)}>
            <Package class={`h-3 w-3 sm:h-5 sm:w-5 ${details?.unpacking > 0 ? 'animate-pulse' : ''}`} />
          </div>
          <span class="text-[10px] sm:text-xs font-medium text-center" class:text-amber-500={details?.unpacking > 0}>
            {$_('updatingOverlay.unpacking')}
          </span>
          {#if details?.unpacking > 0}
            <span class="text-muted-foreground text-[9px] sm:text-xs">{details.unpacking}/{details.total}</span>
          {/if}
        </div>

        <!-- Arrow -->
        <div class="border-muted-foreground/30 w-3 sm:w-6 border-t-2 border-dashed"></div>

        <!-- Install Step -->
        <div
          class="flex flex-col items-center gap-1 sm:gap-2 transition-all duration-300"
          class:opacity-100={details?.setting_up > 0 || animationPhase === 'installing'}
          class:opacity-40={!(details?.setting_up > 0 || animationPhase === 'installing')}>
          <div
            class="flex h-8 w-8 sm:h-12 sm:w-12 items-center justify-center rounded-full border-2 transition-all duration-300"
            class:bg-blue-500={details?.setting_up > 0}
            class:border-blue-500={details?.setting_up > 0}
            class:text-white={details?.setting_up > 0}
            class:border-muted={!(details?.setting_up > 0)}
            class:text-muted-foreground={!(details?.setting_up > 0)}>
            <Cog class={`h-3 w-3 sm:h-5 sm:w-5 ${details?.setting_up > 0 ? 'animate-spin' : ''}`} />
          </div>
          <span class="text-[10px] sm:text-xs font-medium text-center" class:text-blue-500={details?.setting_up > 0}>
            {$_('updatingOverlay.installing')}
          </span>
          {#if details?.setting_up > 0}
            <span class="text-muted-foreground text-[9px] sm:text-xs">{details.setting_up}/{details.total}</span>
          {/if}
        </div>
      </div>


    </div>
  </Drawer.Content>
</Drawer.Root>
