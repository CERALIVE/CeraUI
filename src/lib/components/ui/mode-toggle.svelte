<script lang="ts">
import { resetMode, setMode } from 'mode-watcher';
import { get } from 'svelte/store';
import Moon from 'svelte-radix/Moon.svelte';
import Sun from 'svelte-radix/Sun.svelte';

import { Button } from '$lib/components/ui/button/index.js';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
import { themeStore } from '$lib/stores/theme';

let theme = get(themeStore);

const handleModeChange = (mode: 'light' | 'dark' | 'system') => {
  if (theme === 'system') {
    resetMode();
  } else {
    setMode(mode);
  }
  themeStore.set(mode);
};

handleModeChange(theme);
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    <Button variant="ghost" class="h-8 w-8 px-0" title="Change theme">
      <Sun class="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
      <Moon class="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
      <span class="sr-only">Toggle theme</span>
    </Button>
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" strategy="fixed">
    <DropdownMenu.Item onclick={() => handleModeChange('light')}>Light</DropdownMenu.Item>
    <DropdownMenu.Item onclick={() => handleModeChange('dark')}>Dark</DropdownMenu.Item>
    <DropdownMenu.Item onclick={() => handleModeChange('system')}>System</DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
