<!--
  WifiCountryDialog.svelte — the operator's regulatory-country selection.

  The country is the ONLY thing chosen here. Which channels it permits is decided
  on the device by the kernel and read back from `iw phy` — this dialog never
  names a channel, so it cannot drift from what the radio will actually do.

  Pessimistic, like NetworkIngestDialog: the selection reflects the CONFIRMED
  `config.country` broadcast, and only the in-flight spinner is optimistic. The
  device additionally reports the domain the radio is ACTUALLY on (`effective`),
  so an image with no regulatory database surfaces as a visible mismatch instead
  of a silent no-op.
-->
<script lang="ts">
import { LL, locale } from '@ceraui/i18n/svelte';
import { WORLD_REGULATORY_DOMAIN } from '@ceraui/rpc/schemas';
import { Globe, LoaderCircle, Search } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import {
	countryOptions,
	filterCountries,
	findCountryName,
} from '$lib/helpers/countries';
import { getOperationPhase, osCommand } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { getConfig } from '$lib/rpc/subscriptions.svelte';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const t = $derived($LL.settings.dialogs.wifiCountry);

const OPERATION_KEY = 'wifi-country';
const busy = $derived(getOperationPhase(OPERATION_KEY) === 'pending');

// The confirmed persisted country. Absent = the world domain.
const savedCountry = $derived(getConfig()?.country ?? WORLD_REGULATORY_DOMAIN);

const options = $derived(countryOptions($locale, t.world()));

let query = $state('');
let selected = $state<string | null>(null);

// The selection follows the authoritative broadcast until the operator picks
// something, so re-opening the dialog always shows the device's own truth.
const active = $derived(selected ?? savedCountry);
const visible = $derived(filterCountries(options, query));
const dirty = $derived(active !== savedCountry);

// The radio's own answer after the last apply. A mismatch against `savedCountry`
// means the kernel did not honour the change (no regulatory database on the
// image) — the one condition the operator must not be left guessing about.
let effective = $state<string | undefined>(undefined);
let unavailable = $state(false);
let failed = $state(false);

const mismatch = $derived(
	effective !== undefined && effective !== savedCountry,
);

$effect(() => {
	if (!open) {
		query = '';
		selected = null;
	}
});

async function apply() {
	const next = active === WORLD_REGULATORY_DOMAIN ? undefined : active;
	unavailable = false;
	failed = false;

	const result = await osCommand({
		key: OPERATION_KEY,
		target: active,
		confirmOnResolve: true,
		// The typed refusals render as calm inline bands, never an error toast.
		silent: true,
		rpc: () => rpc.wifi.setCountry({ country: next }),
		classify: () => ({ ok: true }),
	});

	if (!result) {
		failed = true;
		return;
	}

	effective = result.effective;
	if (result.error === 'unavailable_in_emulated_mode') {
		unavailable = true;
		return;
	}
	if (!result.success) {
		failed = true;
		return;
	}
	selected = null;
}
</script>

<AppDialog
	bind:open
	description={t.description()}
	hideFooter
	icon={Globe}
	title={t.title()}
>
	<div class="space-y-4">
		{#if unavailable}
			<div
				class="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-3 text-sm"
				data-testid="wifi-country-unavailable"
				role="status"
			>
				{t.unavailable()}
			</div>
		{/if}

		{#if failed}
			<div
				class="border-status-warning/30 bg-status-warning/10 rounded-lg border px-4 py-3 text-sm"
				data-testid="wifi-country-failed"
				role="status"
			>
				{t.failed()}
			</div>
		{/if}

		{#if mismatch}
			<div
				class="border-status-warning/30 bg-status-warning/10 rounded-lg border px-4 py-3 text-sm"
				data-testid="wifi-country-mismatch"
				role="status"
			>
				{t.mismatchWarning()}
			</div>
		{/if}

		<div class="space-y-2">
			<label class="text-sm font-semibold" for="wifi-country-search">{t.label()}</label>
			<div class="relative">
				<Search
					aria-hidden="true"
					class="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
				/>
				<Input
					id="wifi-country-search"
					autocomplete="off"
					bind:value={query}
					class="ps-9"
					data-testid="wifi-country-search"
					placeholder={t.search()}
				/>
			</div>
		</div>

		<ul
			class="divide-border max-h-64 divide-y overflow-y-auto rounded-lg border"
			data-testid="wifi-country-list"
		>
			{#each visible as option (option.code)}
				<li>
					<button
						type="button"
						aria-pressed={option.code === active}
						class={cn(
							'flex w-full items-center justify-between gap-3 px-4 py-2.5 text-start text-sm transition-colors',
							'hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
							option.code === active && 'bg-primary/10 font-semibold',
						)}
						data-country={option.code}
						data-testid={`wifi-country-option-${option.code}`}
						disabled={busy}
						onclick={() => (selected = option.code)}
					>
						<span class="min-w-0 truncate">{option.name}</span>
						<span class="text-muted-foreground shrink-0 font-mono text-xs">{option.code}</span>
					</button>
				</li>
			{/each}
		</ul>

		<p class="text-muted-foreground text-xs">{t.restartNotice()}</p>

		{#if effective !== undefined}
			<p class="text-muted-foreground text-xs" data-testid="wifi-country-effective">
				{t.effectiveLabel()}: <span class="font-mono">{effective}</span>
			</p>
		{/if}

		<div class="flex items-center justify-end gap-2">
			{#if busy}
				<LoaderCircle
					aria-hidden="true"
					class="text-muted-foreground size-4 animate-spin motion-reduce:animate-none"
				/>
			{/if}
			<Button
				data-testid="wifi-country-apply"
				disabled={busy || !dirty}
				onclick={() => void apply()}
			>
				{busy ? t.applying() : t.apply()}
			</Button>
		</div>

		<p class="text-muted-foreground text-xs" data-testid="wifi-country-saved">
			{findCountryName(options, savedCountry) ?? savedCountry}
		</p>
	</div>
</AppDialog>
