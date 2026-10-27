<!--
  HotspotActivationConfirm.svelte — the ONE gate in front of every hotspot start
  (#413). Turning a radio into an access point can drop the very Wi-Fi link this
  page is served over, so nothing is dispatched until the operator has SEEN the
  exact name and password the AP will broadcast and said they kept them.

  • The credentials come from `wifi.hotspotPrepare`, which resolves them the same
    way the start does (and persists a generated pair), so what is shown is what
    is broadcast. A failed read leaves the confirm DISABLED — never a blind start.
  • The operator may keep them, type their own, or roll a new random password.
    A changed pair is stored through the same RPC BEFORE `onConfirm` runs.
  • The acknowledgement covers what is on screen: editing either field clears it.
  • Inline, not a modal: it renders inside `HotspotDialog` and the mode popover,
    both already layered (see `WifiModeSelector` rule 3).
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Copy, Dices, Loader2, TriangleAlert } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { networkConstraints } from '$lib/components/streaming';
import { Button } from '$lib/components/ui/button';
import { Checkbox } from '$lib/components/ui/checkbox';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { copyToClipboard } from '$lib/helpers/clipboard';
import { rpc } from '$lib/rpc/client';

import { generateHotspotPassword, hotspotPasswordIsPrintable } from './hotspot-password';

interface Props {
	/** WiFi interface device key (record key in the wifi status map). */
	device: string;
	/** The radio's station leg survives (hybrid), so no disconnect is threatened. */
	keepsStation?: boolean;
	/** Action label; defaults to "Turn on hotspot". */
	confirmLabel?: string;
	/** An extra consequence the caller already knows (e.g. the link leaves the bond). */
	detail?: string;
	onConfirm: () => void;
	onCancel: () => void;
}

const { device, keepsStation = false, confirmLabel, detail, onConfirm, onCancel }: Props =
	$props();

const bounds = networkConstraints.hotspot;

let phase = $state<'loading' | 'ready' | 'load-failed' | 'saving'>('loading');
let saveFailed = $state(false);
// Never hosted before: the gate doubles as the first-time setup.
let firstTime = $state(false);
let loaded = { name: '', password: '' };
let name = $state('');
let password = $state('');
let acknowledged = $state(false);

async function load() {
	phase = 'loading';
	try {
		const result = await rpc.wifi.hotspotPrepare({ device });
		if (!result.success || !result.name || !result.password) throw new Error('unavailable');
		loaded = { name: result.name, password: result.password };
		firstTime = result.firstTime === true;
		name = result.name;
		password = result.password;
		phase = 'ready';
	} catch {
		phase = 'load-failed';
	}
}

$effect(() => {
	void load();
});

const nameError = $derived(
	name.length < bounds.name.min
		? m['hotspotConfigurator.validation.nameMinLength']()
		: name.length > bounds.name.max
			? m['hotspotConfigurator.validation.nameMaxLength']()
			: '',
);
const passwordError = $derived(
	password.length < bounds.password.min
		? m['hotspotConfigurator.validation.passwordMinLength']()
		: password.length > bounds.password.max
			? m['hotspotConfigurator.validation.passwordMaxLength']()
			: !hotspotPasswordIsPrintable(password)
				? m['hotspotConfirm.passwordCharacters']()
				: '',
);
const canConfirm = $derived(phase === 'ready' && acknowledged && !nameError && !passwordError);

// The acknowledgement is for the pair on screen; a new pair needs a new one.
function edited() {
	acknowledged = false;
	saveFailed = false;
}

function rollPassword() {
	password = generateHotspotPassword();
	edited();
}

async function copy(value: string, success: string) {
	if (await copyToClipboard(value)) {
		toast.success(success);
	} else {
		toast.error(m['network.clipboard.copyFailed'](), {
			description: m['network.clipboard.copyFailedDescription'](),
		});
	}
}

async function confirm() {
	if (!canConfirm) return;
	if (name !== loaded.name || password !== loaded.password) {
		phase = 'saving';
		try {
			const result = await rpc.wifi.hotspotPrepare({ device, name, password });
			if (!result.success || result.name !== name || result.password !== password) {
				throw new Error('not-stored');
			}
			loaded = { name, password };
		} catch {
			phase = 'ready';
			saveFailed = true;
			return;
		}
		phase = 'ready';
	}
	onConfirm();
}
</script>

<div
	class="border-status-warning/30 bg-status-warning/10 space-y-3 rounded-lg border p-3"
	data-device={device}
	data-phase={phase}
	data-testid="hotspot-activation-confirm"
	role="group"
	aria-labelledby="hotspot-confirm-title-{device}"
>
	<div class="flex items-start gap-2">
		<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
		<div class="space-y-1">
			<p id="hotspot-confirm-title-{device}" class="text-sm font-semibold">
				{firstTime ? m['hotspotConfirm.firstTimeTitle']() : m['hotspotConfirm.title']()}
			</p>
			{#if firstTime}
				<p class="text-muted-foreground text-xs" data-testid="hotspot-confirm-first-time">
					{m['hotspotConfirm.firstTimeBody']()}
				</p>
			{/if}
			<p class="text-muted-foreground text-xs">
				{keepsStation ? m['hotspotConfirm.bodyKeepsStation']() : m['hotspotConfirm.body']()}
			</p>
			{#if detail}
				<p class="text-muted-foreground text-xs">{detail}</p>
			{/if}
		</div>
	</div>

	{#if phase === 'loading'}
		<p class="text-muted-foreground flex items-center gap-2 text-xs" role="status">
			<Loader2 aria-hidden="true" class="size-3.5 animate-spin motion-reduce:animate-none" />
			{m['hotspotConfirm.loading']()}
		</p>
	{:else if phase === 'load-failed'}
		<div class="space-y-2" role="alert" data-testid="hotspot-confirm-load-failed">
			<p class="text-destructive text-xs">{m['hotspotConfirm.loadFailed']()}</p>
			<Button class="h-8 min-h-[var(--touch-target-min)]" onclick={load} size="sm" variant="secondary">
				{m['hotspotConfirm.retry']()}
			</Button>
		</div>
	{:else}
		<div class="space-y-1.5">
			<Label class="text-xs font-medium" for="hotspot-confirm-name-{device}">
				{m['network.hotspot.name']()}
			</Label>
			<div class="relative">
				<Input
					id="hotspot-confirm-name-{device}"
					class="bg-background pe-10 font-mono"
					autocapitalize="none"
					autocomplete="off"
					autocorrect="off"
					spellcheck={false}
					aria-invalid={Boolean(nameError)}
					data-testid="hotspot-confirm-name"
					maxlength={bounds.name.max}
					oninput={edited}
					bind:value={name}
				/>
				<Button
					class="absolute end-1 top-1/2 size-8 -translate-y-1/2 rounded-md"
					aria-label={m['network.accessibility.copyName']()}
					disabled={!name}
					onclick={() => copy(name, m['network.clipboard.nameCopied']())}
					size="icon"
					type="button"
					variant="ghost"
				>
					<Copy class="size-4" />
				</Button>
			</div>
			{#if nameError}
				<p class="text-destructive text-xs">{nameError}</p>
			{/if}
		</div>

		<div class="space-y-1.5">
			<Label class="text-xs font-medium" for="hotspot-confirm-password-{device}">
				{m['network.hotspot.password']()}
			</Label>
			<div class="relative">
				<!-- Visible by default: the whole point is that it gets written down. -->
				<Input
					id="hotspot-confirm-password-{device}"
					class="bg-background pe-10 font-mono"
					autocapitalize="none"
					autocomplete="off"
					autocorrect="off"
					spellcheck={false}
					aria-invalid={Boolean(passwordError)}
					data-testid="hotspot-confirm-password"
					maxlength={bounds.password.max}
					oninput={edited}
					type="text"
					bind:value={password}
				/>
				<Button
					class="absolute end-1 top-1/2 size-8 -translate-y-1/2 rounded-md"
					aria-label={m['network.accessibility.copyPassword']()}
					disabled={!password}
					onclick={() => copy(password, m['network.clipboard.passwordCopied']())}
					size="icon"
					type="button"
					variant="ghost"
				>
					<Copy class="size-4" />
				</Button>
			</div>
			{#if passwordError}
				<p class="text-destructive text-xs">{passwordError}</p>
			{/if}
			<Button
				class="h-8 min-h-[var(--touch-target-min)] px-2"
				data-testid="hotspot-confirm-generate"
				onclick={rollPassword}
				size="sm"
				type="button"
				variant="ghost"
			>
				<Dices aria-hidden="true" class="size-4" />
				{m['hotspotConfirm.generate']()}
			</Button>
		</div>

		<label class="flex cursor-pointer items-start gap-2.5 text-xs" for="hotspot-confirm-ack-{device}">
			<Checkbox
				id="hotspot-confirm-ack-{device}"
				class="mt-0.5 size-5"
				data-testid="hotspot-confirm-ack"
				bind:checked={acknowledged}
			/>
			<span>{m['hotspotConfirm.acknowledge']()}</span>
		</label>

		{#if saveFailed}
			<p class="text-destructive text-xs" role="alert" data-testid="hotspot-confirm-save-failed">
				{m['hotspotConfirm.saveFailed']()}
			</p>
		{/if}
	{/if}

	<div class="flex flex-wrap justify-end gap-2">
		<Button
			class="h-9 min-h-[var(--touch-target-min)]"
			data-testid="hotspot-confirm-cancel"
			onclick={onCancel}
			size="sm"
			variant="outline"
		>
			{m['dialog.cancel']()}
		</Button>
		<Button
			class="h-9 min-h-[var(--touch-target-min)]"
			data-testid="hotspot-confirm-activate"
			disabled={!canConfirm}
			onclick={confirm}
			size="sm"
		>
			{#if phase === 'saving'}
				<Loader2 aria-hidden="true" class="size-4 animate-spin motion-reduce:animate-none" />
			{/if}
			{confirmLabel ?? m['hotspotConfirm.activate']()}
		</Button>
	</div>
</div>
