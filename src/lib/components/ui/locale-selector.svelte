<script lang="ts">
import { existingLocales } from '../../../i18n';
import { get } from 'svelte/store';
import { locale } from 'svelte-i18n';
import * as Select from '$lib/components/ui/select';
import { localeStore } from '$lib/stores/locale';
const initialLocale = get(localeStore);

let selectedLocale = $state(initialLocale.code);
let localeName = $derived.by(() => existingLocales.find(l => l.code === selectedLocale)!.name);
locale.set(initialLocale.code);
const handleLocaleChange = (value: string) => {
  locale.set(value);
  localeStore.set(existingLocales.find(l => l.code === value)!);
  selectedLocale = value;
};
</script>

<Select.Root type="single" value={selectedLocale} onValueChange={handleLocaleChange}>
  <Select.Trigger>
    {localeName}
  </Select.Trigger>
  <Select.Content>
    <Select.Group>
      {#each existingLocales as locale}
        <Select.Item value={locale.code} label={locale.name}></Select.Item>
      {/each}
    </Select.Group>
  </Select.Content>
</Select.Root>
