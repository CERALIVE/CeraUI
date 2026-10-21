<!--
  UpdateCredentialsRow.svelte — the public expiry date of the device's update
  certificate and the device's verdict about it.

  Rendered inside the Update connection section, because the certificate is
  what the update connection presents. An older backend sends no `credentials`
  block and this renders nothing at all. The state is a WORD in a badge, in
  the foreground colour (the shared status-pill text tones measure below AA
  for error and dark neutral); a shield glyph and the pill tint carry the tone.
  What may be said for each wire value lives in
  `credentialExpiryView()`. The date is a certificate fact, not proof that the
  server accepts the certificate; a rejection is the dialog's own band.
-->
<script lang="ts">
import { getLocale, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { UpdateCredentials } from '@ceraui/rpc/schemas';
import { ShieldAlert, ShieldCheck, ShieldQuestionMark, ShieldX } from '@lucide/svelte';

import Badge from '$lib/components/custom/Badge.svelte';
import {
	CREDENTIAL_EXPIRY_COPY_KEYS,
	CREDENTIAL_EXPIRY_TITLE_KEY,
	type CredentialExpiryState,
	credentialExpiryView,
	credentialRemainingCopy,
} from '$lib/updates/credential-expiry';
import { formatUpdateTime } from '$lib/updates/update-view';

const STATE_ICON: Readonly<Record<CredentialExpiryState, typeof ShieldCheck>> = {
	valid: ShieldCheck,
	expiring: ShieldAlert,
	expired: ShieldX,
	unavailable: ShieldQuestionMark,
};

interface Props {
	/** `undefined` = an older backend that reports no credentials block. */
	credentials: UpdateCredentials | undefined;
}

let { credentials }: Props = $props();

const uid = $props.id();
const labelId = `${uid}-label`;
const locale = $derived(getLocale());
// Bumped when the whole-day count changes, so an open row never shows a stale count.
let clockTick = $state(0);
const view = $derived.by(() => {
	void clockTick;
	return credentialExpiryView(credentials, Date.now());
});

$effect(() => {
	const delay = view?.recountInMs;
	if (delay === undefined) return;
	const timer = setTimeout(() => {
		clockTick += 1;
	}, delay);
	return () => clearTimeout(timer);
});
const StateIcon = $derived(STATE_ICON[view?.state ?? 'unavailable']);
const date = $derived(formatUpdateTime(view?.expiresAt, locale));
const remaining = $derived(credentialRemainingCopy(view?.daysLeft, locale));
</script>

{#if view}
	<div
		aria-labelledby={labelId}
		class="space-y-1.5 rounded-lg border px-4 py-3"
		data-state={view.state}
		data-testid="update-credentials"
		role="group"
	>
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-sm font-semibold" id={labelId}>{resolveMessageKey(CREDENTIAL_EXPIRY_TITLE_KEY)}</span>
			<Badge data-testid="update-credentials-state" variant={view.tone}>
				{#snippet icon()}
					<StateIcon aria-hidden="true" class="size-3 shrink-0" />
				{/snippet}
				<span class="text-foreground">{resolveMessageKey(view.stateKey)}</span>
			</Badge>
		</div>
		{#if date}
			<p class="text-muted-foreground flex flex-wrap gap-x-2 text-xs" data-testid="update-credentials-date">
				<span>{resolveMessageKey(view.detailKey, { date })}</span>
				{#if remaining}
					<span aria-hidden="true">·</span>
					<span class="text-foreground font-medium" data-testid="update-credentials-remaining">
						{resolveMessageKey(remaining.key, remaining.params)}
					</span>
				{/if}
			</p>
		{:else}
			<p class="text-muted-foreground text-xs" data-testid="update-credentials-unreadable">
				{resolveMessageKey(CREDENTIAL_EXPIRY_COPY_KEYS.unreadable)}
			</p>
		{/if}
	</div>
{/if}
