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
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { WifiInterface } from '@ceraui/rpc/schemas';
import { Copy, Dices, Loader2, TriangleAlert } from '@lucide/svelte';
import { onDestroy, tick, untrack } from 'svelte';
import { toast } from 'svelte-sonner';

import { networkConstraints } from '$lib/components/streaming';
import { Button } from '$lib/components/ui/button';
import { Checkbox } from '$lib/components/ui/checkbox';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { copyToClipboard } from '$lib/helpers/clipboard';
import { rpc } from '$lib/rpc/client';
import { getLinkEpoch } from '$lib/rpc/session-epoch.svelte';
import { waitForWifiStatus } from '$lib/rpc/wifi-status-receipt';

import { generateHotspotPassword, hotspotPasswordIsPrintable } from './hotspot-password';
import { sameWifiRadio, type WifiRadioBinding, wifiRadioChanged } from './wifi-radio-binding';

interface Props {
	/** WiFi interface device key (record key in the wifi status map). */
	device: string;
	incarnation?: string;
	degradedReason?: WifiInterface['degraded_reason'];
	session?: number;
	reloaded?: boolean;
	focusOnOpen?: boolean;
	locked?: boolean;
	/** The radio's station leg survives (hybrid), so no disconnect is threatened. */
	keepsStation?: boolean;
	/** Action label; defaults to "Turn on hotspot". */
	confirmLabel?: string;
	/** An extra consequence the caller already knows (e.g. the link leaves the bond). */
	detail?: string;
	onConfirm: (incarnation: string) => void;
	onCancel: () => void;
}

const { device, incarnation, degradedReason, session = 0, reloaded = false, focusOnOpen = false, locked = false, keepsStation = false, confirmLabel, detail, onConfirm, onCancel }: Props =
	$props();
const uid = $props.id();
let panel: HTMLDivElement;
let cancelButton = $state<HTMLButtonElement | null>(null);

$effect(() => {
	if (focusOnOpen) cancelButton?.focus();
});

const bounds = networkConstraints.hotspot;

let phase = $state<'loading' | 'ready' | 'load-failed' | 'saving' | 'unsupported' | 'unverified'>('loading');
let saveFailed = $state(false);
let invalidated = $state(false);
let refused = $state(false);
let binding: WifiRadioBinding | undefined;
let attempt = 0;
let awaitingStatus = false;
let observation: AbortController | undefined;
const radioDevice = $derived(device);
const radioToken = $derived(incarnation);
const radioReason = $derived(degradedReason);
const ownerSession = $derived(session);
// Never hosted before: the gate doubles as the first-time setup.
let firstTime = $state(false);
let loaded = { name: '', password: '' };
let name = $state('');
let password = $state('');
let acknowledged = $state(false);

function current(seq: number, captured: WifiRadioBinding): boolean {
	return seq === attempt && sameWifiRadio(captured, {
		device, incarnation, link: getLinkEpoch(), session,
	}) && degradedReason === undefined;
}

onDestroy(() => { attempt += 1; observation?.abort(); });

async function prepare(captured: WifiRadioBinding, seq: number, chosen?: { name: string; password: string }, recover = true) {
	const { incarnation: token } = captured;
	if (!token) return;
	const invoke = () => rpc.wifi.hotspotPrepare({
		device: captured.device, incarnation: token, ...chosen,
	});
	let retried = false;
	let result = await invoke();
	if (recover && result.reason === 'current-unobserved' && current(seq, captured)) {
		const controller = new AbortController();
		observation = controller;
		awaitingStatus = true;
		const next = await waitForWifiStatus(captured.device, controller.signal);
		await tick();
		if (observation === controller) { observation = undefined; awaitingStatus = false; }
		if (seq !== attempt || captured.device !== device || captured.link !== getLinkEpoch() ||
			(chosen !== undefined && locked)) return;
		if (!next?.incarnation) {
			focusBeforeReload();
			phase = 'unsupported';
			acknowledged = false;
			return;
		}
		if (next.incarnation !== token || !current(seq, captured)) {
			invalidated = true;
			acknowledged = false;
			// A fresh load has no draft and does not inherit this recovery.
			if (incarnation && incarnation !== token) void load(false);
			else {
				focusBeforeReload();
				phase = 'load-failed';
			}
			return;
		}
		retried = true;
		result = await invoke();
	}
	return { result, retried };
}

function focusBeforeReload() {
	if (panel?.contains(document.activeElement)) cancelButton?.focus();
}

async function load(recover = true): Promise<void> {
	focusBeforeReload();
	observation?.abort();
	observation = undefined;
	awaitingStatus = false;
	const captured = { device, incarnation, link: getLinkEpoch(), session };
	const seq = ++attempt;
	binding = captured;
	acknowledged = false;
	saveFailed = false;
	refused = false;
	name = '';
	password = '';
	firstTime = false;
	if (degradedReason) {
		phase = 'unverified';
		return;
	}
	if (!captured.incarnation) {
		phase = 'unsupported';
		return;
	}
	phase = 'loading';
	try {
		const response = await prepare(captured, seq, undefined, recover);
		if (!response || !current(seq, captured)) return;
		const { result } = response;
		if (result.error === 'radio-unverified') {
			phase = 'unverified';
			return;
		}
		if (wifiRadioChanged(result)) {
			if (response.retried) invalidated = true;
			refused = true;
			phase = 'load-failed';
			return;
		}
		if (!result.success || !result.name || !result.password) throw new Error('unavailable');
		loaded = { name: result.name, password: result.password };
		firstTime = result.firstTime === true;
		name = result.name;
		password = result.password;
		phase = 'ready';
	} catch {
		if (current(seq, captured)) phase = 'load-failed';
	}
}

$effect.pre(() => {
	const next = {
		device: radioDevice, incarnation: radioToken, link: getLinkEpoch(), session: ownerSession,
	};
	radioReason;
	untrack(() => {
		invalidated = binding !== undefined && !sameWifiRadio(binding, next);
		if (awaitingStatus && binding && binding.device === next.device &&
			binding.link === next.link && binding.incarnation !== next.incarnation) return;
		void load();
	});
});

// The binding can stay the same while another tab changes the credentials or
// uplink. A lock edge retires a submitted acknowledgement and its retry.
let wasLocked = false;
$effect.pre(() => {
	const busy = locked;
	untrack(() => {
		if (busy && !wasLocked) {
			acknowledged = false;
			if (phase === 'saving') {
				attempt += 1;
				observation?.abort();
				phase = 'ready';
			}
		} else if (!busy && wasLocked) {
			void load();
		}
		wasLocked = busy;
	});
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
const canConfirm = $derived(!locked && phase === 'ready' && acknowledged && !nameError && !passwordError);

// The acknowledgement is for the pair on screen; a new pair needs a new one.
function edited() {
	if (phase === 'saving') {
		attempt += 1;
		phase = 'ready';
	}
	acknowledged = false;
	saveFailed = false;
	refused = false;
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
	const captured = binding;
	const seq = attempt;
	if (!canConfirm || !captured?.incarnation || !current(seq, captured)) return;
	const chosen = { name, password };
	if (name !== loaded.name || password !== loaded.password) {
		phase = 'saving';
		try {
			const response = await prepare(captured, seq, chosen);
			if (!response || !current(seq, captured)) return;
			const { result } = response;
			if (result.error === 'radio-unverified') {
				focusBeforeReload();
				phase = 'unverified';
				acknowledged = false;
				return;
			}
			if (wifiRadioChanged(result)) {
				if (response.retried) invalidated = true;
				refused = true;
				acknowledged = false;
				phase = 'ready';
				return;
			}
			if (!result.success || result.name !== chosen.name || result.password !== chosen.password) {
				throw new Error('not-stored');
			}
			loaded = chosen;
		} catch {
			if (!current(seq, captured)) return;
			phase = 'ready';
			saveFailed = true;
			return;
		}
		phase = 'ready';
	}
	if (!locked && current(seq, captured)) onConfirm(captured.incarnation);
}
</script>

<!-- biome-ignore lint/a11y/useSemanticElements: This warning and confirmation panel is a named action group; a fieldset introduces form-group sizing and an anonymous content box. -->
<div
	bind:this={panel}
	class="border-status-warning/30 bg-status-warning/10 space-y-3 rounded-lg border p-3"
	data-device={device}
	data-phase={phase}
	data-testid="hotspot-activation-confirm"
	role="group"
	aria-labelledby="hotspot-confirm-title-{uid}"
>
	<div class="flex items-start gap-2">
		<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
		<div class="space-y-1">
			<p id="hotspot-confirm-title-{uid}" class="text-sm font-semibold">
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

	{#if invalidated || reloaded}
		<p class="text-muted-foreground text-xs" role="status" data-testid="hotspot-confirm-radio-changed">
			{m['hotspotConfirm.radioChanged']()}
		</p>
	{/if}
	{#if refused}
		<p class="text-muted-foreground text-xs" role="status">{m['hotspotConfirm.radioChangedNotSaved']()}</p>
	{/if}
	{#if phase === 'unsupported' || phase === 'unverified'}
		<p class="text-muted-foreground text-xs" role="status" data-testid="hotspot-confirm-unavailable">
			{#if radioReason}{resolveMessageKey(`network.wifiDegraded.${radioReason}`)} {/if}
			{phase === 'unverified' ? m['hotspotConfirm.radioUnverified']() : m['hotspotConfirm.bindingUnsupported']()}
		</p>
	{:else if phase === 'loading'}
		<p class="text-muted-foreground flex items-center gap-2 text-xs" role="status">
			<Loader2 aria-hidden="true" class="size-3.5 animate-spin motion-reduce:animate-none" />
			{m['hotspotConfirm.loading']()}
		</p>
	{:else if phase === 'load-failed'}
		<div class="space-y-2" role="alert" data-testid="hotspot-confirm-load-failed">
			<p class="text-destructive text-xs">{m['hotspotConfirm.loadFailed']()}</p>
			<Button class="h-8 min-h-[var(--touch-target-min)]" onclick={() => load()} size="sm" variant="secondary">
				{m['hotspotConfirm.retry']()}
			</Button>
		</div>
	{:else}
		<div class="space-y-1.5">
			<Label class="text-xs font-medium" for="hotspot-confirm-name-{uid}">
				{m['network.hotspot.name']()}
			</Label>
			<div class="relative">
				<Input
					id="hotspot-confirm-name-{uid}"
					class="bg-background pe-10 font-mono"
					autocapitalize="none"
					autocomplete="off"
					autocorrect="off"
					spellcheck={false}
					aria-invalid={Boolean(nameError)}
					data-testid="hotspot-confirm-name"
					maxlength={bounds.name.max}
					readonly={locked}
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
			<Label class="text-xs font-medium" for="hotspot-confirm-password-{uid}">
				{m['network.hotspot.password']()}
			</Label>
			<div class="relative">
				<!-- Visible by default: the whole point is that it gets written down. -->
				<Input
					id="hotspot-confirm-password-{uid}"
					class="bg-background pe-10 font-mono"
					autocapitalize="none"
					autocomplete="off"
					autocorrect="off"
					spellcheck={false}
					aria-invalid={Boolean(passwordError)}
					data-testid="hotspot-confirm-password"
					maxlength={bounds.password.max}
					readonly={locked}
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
				disabled={locked}
				onclick={rollPassword}
				size="sm"
				type="button"
				variant="ghost"
			>
				<Dices aria-hidden="true" class="size-4" />
				{m['hotspotConfirm.generate']()}
			</Button>
		</div>

		<label class="flex cursor-pointer items-start gap-2.5 text-xs" for="hotspot-confirm-ack-{uid}">
			<Checkbox
				id="hotspot-confirm-ack-{uid}"
				class="mt-0.5 size-5"
				data-testid="hotspot-confirm-ack"
				disabled={locked}
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
			bind:ref={cancelButton}
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
