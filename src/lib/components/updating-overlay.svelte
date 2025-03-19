<script lang="ts">
import { _ } from 'svelte-i18n';
import { toast } from 'svelte-sonner';

import * as Drawer from '$lib/components/ui/drawer/index.js';
import { Progress } from '$lib/components/ui/progress';
import type { StatusMessage } from '$lib/types/socket-messages';

let { details }: { details: Exclude<StatusMessage['updating'], boolean | null> } = $props();

let progress: number = $derived.by(() => {
  let { downloading: downloading = 0, unpacking: unpacking = 0, setting_up: setting_up = 0 } = details;
  return downloading + unpacking + setting_up;
});
let total: number = $derived(3 * (details.total ?? 0));

$effect(() => {
  if (progress === total)
    toast.success($_('updatingOverlay.successMessage'), {
      description: $_('updatingOverlay.successDescription'),
    });
});
</script>

<Drawer.Root open={true} closeOnOutsideClick={false} closeOnEscape={false}>
  <Drawer.Content class="h-[100%] w-[100%] bg-transparent/50 " disableDrag={true} data-vaul-no-drag>
    <div class="h-[100%] w-[100%]">
      <Drawer.Header>
        <div>
          <Drawer.Title>
            <div class="loading">{$_('updatingOverlay.title')}</div>
          </Drawer.Title>
          <Drawer.Description>
            <div>{$_('updatingOverlay.description')}</div>
            <div class="text-area mt-5 mr-auto ml-auto w-[100%] resize-none text-lg disabled:cursor-default md:w-[50%]">
              <b class="loading">{$_('updatingOverlay.loading')}</b>
              {#if total}
                {#if details.downloading}
                  <p><b>{$_('updatingOverlay.downloading')}:</b> {`${details.downloading ?? 0}/${details.total}`}</p>
                {/if}
                {#if details.unpacking}
                  <p><b>{$_('updatingOverlay.unpacking')}:</b> {`${details.unpacking ?? 0}/${details.total}`}</p>
                {/if}
                {#if details.setting_up}
                  <p><b>{$_('updatingOverlay.installing')}:</b> {`${details.setting_up ?? 0}/${details.total}`}</p>
                {/if}
                <p><b>{$_('updatingOverlay.progress')}:</b> {`${((100 * progress) / total).toFixed(2)}%`}</p>
              {/if}
            </div>
          </Drawer.Description>
        </div>
      </Drawer.Header>
      <div class="absolute bottom-[20%] grid w-[100%] justify-center p-4 pb-0 text-center">
        <div class="flex justify-center">
          <img alt="" src="src/assets/images/1672353.svg" width="40%" />
        </div>
        <div class="flex justify-center">
          <Progress class="bg-accent w-[60%]" max={total} value={progress}></Progress>
        </div>
      </div>
      <Drawer.Footer></Drawer.Footer>
    </div>
  </Drawer.Content>
</Drawer.Root>
