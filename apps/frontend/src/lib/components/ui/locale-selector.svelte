<script lang="ts">
import { Globe } from '@lucide/svelte';
import { get } from 'svelte/store';
import { _, locale } from 'svelte-i18n';

import * as Select from '$lib/components/ui/select';
import { localeStore } from '$lib/stores/locale';
import { cn } from '$lib/utils';

import { existingLocales } from '../../../i18n';

const initialLocale = get(localeStore);

let selectedLocale = $state(initialLocale.code);
const localeName = $derived.by(() => existingLocales.find((l) => l.code === selectedLocale)!.name);
const localeFlag = $derived.by(() => existingLocales.find((l) => l.code === selectedLocale)!.flag);

// Initialize locale in an effect to avoid top-level state updates
$effect(() => {
  locale.set(initialLocale.code);
});

const handleLocaleChange = (value: string) => {
  locale.set(value);
  localeStore.set(existingLocales.find((l) => l.code === value)!);
  selectedLocale = value;
};
</script>

<Select.Root onValueChange={handleLocaleChange} type="single" value={selectedLocale}>
  <Select.Trigger
    class="h-10 min-w-[120px] rounded-xl bg-gradient-to-br from-gray-100 to-gray-200 shadow-sm transition-all duration-200 hover:from-gray-200 hover:to-gray-300 hover:shadow-md dark:from-gray-800 dark:to-gray-900 dark:hover:from-gray-700 dark:hover:to-gray-800"
  >
    <!-- Enhanced Trigger Content -->
    <div class="flex items-center gap-2">
      {#if localeFlag}
        <span class="text-lg" aria-label={localeName} role="img">{localeFlag}</span>
      {:else}
        <Globe class="h-4 w-4 text-gray-600 dark:text-gray-400" />
      {/if}
      <span class="text-sm font-medium">{localeName}</span>
    </div>
  </Select.Trigger>

  <Select.Content
    class="min-w-[180px] rounded-xl border-2 bg-white/95 p-2 shadow-xl backdrop-blur-md dark:bg-gray-900/95"
  >
    <!-- Language Header -->
    <div class="mb-2 px-2 py-1">
      <h4 class="text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
        {$_('locale.selectLanguage')}
      </h4>
    </div>

    <Select.Group>
      {#each existingLocales as localeOption}
        {@const isActive = selectedLocale === localeOption.code}
        <Select.Item
          class={cn(
            'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200',
            isActive
              ? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-md'
              : 'hover:bg-gray-100 dark:hover:bg-gray-800'
          )}
          label={localeOption.name}
          value={localeOption.code}
        >
          <!-- Language Flag/Icon -->
          <div
            class={cn(
              'flex h-6 w-6 items-center justify-center rounded-md text-base transition-colors',
              isActive ? 'bg-white/20' : 'bg-gray-100 dark:bg-gray-800'
            )}
          >
            {#if localeOption.flag}
              <span aria-label={localeOption.name} role="img">{localeOption.flag}</span>
            {:else}
              <Globe
                class={cn(
                  'h-3.5 w-3.5',
                  isActive ? 'text-white' : 'text-gray-600 dark:text-gray-400'
                )}
              />
            {/if}
          </div>

          <!-- Language Info -->
          <div class="flex-1">
            <div
              class={cn(
                'font-medium',
                isActive ? 'text-white' : 'text-gray-900 dark:text-gray-100'
              )}
            >
              {localeOption.name}
            </div>
            <div
              class={cn('text-xs', isActive ? 'text-white/80' : 'text-gray-500 dark:text-gray-400')}
            >
              {localeOption.code.toUpperCase()}
            </div>
          </div>

          <!-- Active Indicator -->
          {#if isActive}
            <div class="h-2 w-2 rounded-full bg-white shadow-sm"></div>
          {/if}
        </Select.Item>
      {/each}
    </Select.Group>
  </Select.Content>
</Select.Root>
