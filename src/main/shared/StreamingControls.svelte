<script lang="ts">
import { Play, Square } from '@lucide/svelte';
import { _ } from 'svelte-i18n';
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';

interface Props {
  isStreaming: boolean;
  onStart: () => void;
  onStop: () => void;
  disabled?: boolean;
}

let { isStreaming, onStart, onStop, disabled = false }: Props = $props();

const handleStart = () => {
  if (!disabled) {
    onStart();
  }
};

const handleStop = () => {
  // Directly dismiss all toasts first for immediate visual feedback
  toast.dismiss();

  if (window.stopStreamingWithNotificationClear) {
    window.stopStreamingWithNotificationClear();
  } else {
    // Fallback
    import('$lib/helpers/SystemHelper').then(module => {
      module.stopStreaming();
    });
  }
  onStop();
};
</script>

<div class="bg-background/95 sticky top-0 z-10 border-b p-6 pb-4 backdrop-blur-sm">
  <div class="mx-auto max-w-4xl">
    {#if isStreaming}
      <Button
        type="button"
        size="lg"
        class="group w-full bg-orange-600 shadow-lg transition-all duration-200 hover:bg-orange-700"
        onclick={handleStop}>
        <Square class="mr-2 h-5 w-5 transition-transform group-hover:scale-110" />
        {$_('settings.stopStreaming')}
      </Button>
    {:else}
      <Button
        type="submit"
        size="lg"
        class="group w-full bg-gradient-to-r from-green-600 to-green-700 shadow-lg transition-all duration-200 hover:from-green-700 hover:to-green-800"
        {disabled}
        onclick={handleStart}>
        <Play class="mr-2 h-5 w-5 transition-transform group-hover:scale-110" />
        {$_('settings.startStreaming')}
      </Button>
    {/if}

    {#if disabled}
      <p class="text-muted-foreground mt-2 text-center text-sm">
        {$_('settings.completeRequiredFields')}
      </p>
    {/if}
  </div>
</div>
