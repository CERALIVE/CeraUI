<!--
  UpdateCredentialsRow.svelte — the public expiry date of the device's update
  certificate and the device's verdict about it (lane CRED-UI).

  Rendered inside the Update connection section, because the certificate is
  what the update connection presents. An older backend sends no `credentials`
  block and this renders nothing at all. The state is a WORD in a badge; the
  tone only reinforces it. What may be said for each wire value lives in
  `credentialExpiryView()`. The date is a certificate fact, not proof that the
  server accepts the certificate; a rejection is the dialog's own band.
-->
<script lang="ts">
import { getLocale, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { UpdateCredentials } from '@ceraui/rpc/schemas';

import Badge from '$lib/components/custom/Badge.svelte';
import {
	CREDENTIAL_EXPIRY_COPY_KEYS,
	CREDENTIAL_EXPIRY_TITLE_KEY,
	credentialExpiryView,
	credentialRemainingCopy,
} from '$lib/updates/credential-expiry';
import { formatUpdateTime } from '$lib/updates/update-view';

interface Props {
	/** `undefined` = an older backend that reports no credentials block. */
	credentials: UpdateCredentials | undefined;
}

let { credentials }: Props = $props();

const uid = $props.id();
const labelId = `${uid}-label`;
const locale = $derived(getLocale());
// Recomputed whenever the device's answer changes; the dialog re-reads it on every open.
const view = $derived(credentialExpiryView(credentials, Date.now()));
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
			<Badge data-testid="update-credentials-state" label={resolveMessageKey(view.stateKey)} variant={view.tone} />
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
