<!--
  StorageSection.svelte: the Storage region of System Logs: what logs use, the
  retention limits and the cleanup actions, over the logs storage RPCs. It owns
  its refreshes and reuses the shell's initial reading.
-->
<script lang="ts">
import type { LogStorage } from '@ceraui/rpc/schemas';

import { Skeleton } from '$lib/components/ui/skeleton';
import { m } from '$lib/device-logs/storage-messages';
import { LINE_BREAKS, parseStorage } from '$lib/device-logs/storage-readout';
import { rpc } from '$lib/rpc/client';

import RecoveryBand from './RecoveryBand.svelte';
import StorageCleanup from './StorageCleanup.svelte';
import StorageLimits from './StorageLimits.svelte';
import StorageUsage from './StorageUsage.svelte';

// null means the shell received a malformed reply, so offer Retry without a second scan.
let { storage = $bindable() }: { storage?: LogStorage | null } = $props();

/**
 * The reading on screen when the newest read failed (null: none failed). The
 * band shows only while that reading is still the one on screen, so a newer
 * reading, from a read or an action's reply, retires it.
 */
let failedOn = $state.raw<LogStorage | undefined | null>(null);
const readFailed = $derived(storage === null || failedOn === storage);
let reading = $state(false);
let latestRead = 0;

async function refresh(): Promise<void> {
	const read = ++latestRead;
	const shown = storage;
	reading = true;
	try {
		const reply = parseStorage(await rpc.logs.getStorage());
		if (read !== latestRead) return;
		// A reply an action delivered while this read ran is newer than the read.
		if (storage === shown) storage = reply;
		failedOn = null;
	} catch (error) {
		if (read !== latestRead) return;
		console.error('System Logs storage read failed:', error);
		failedOn = shown;
	} finally {
		if (read === latestRead) reading = false;
	}
}

// Retry while its own read runs would only race it.
function retry(): Promise<void> | undefined {
	if (!reading) return refresh();
}

if (storage === undefined) void refresh();
</script>

<div class="flex max-w-2xl flex-col gap-6 {LINE_BREAKS}" data-testid="storage-section">
	{#if readFailed}
		<RecoveryBand busy={reading} message={m['systemLogs.storage.loadFailed']()} onretry={retry} testid="storage-load-failed" />
	{/if}
	{#if storage}
		<StorageUsage {storage} />
		<StorageLimits bind:storage />
		<StorageCleanup bind:storage onrefresh={refresh} />
	{:else if !readFailed}
		<div aria-busy="true" class="flex flex-col gap-3" data-testid="storage-loading" role="status">
			<span class="sr-only">{m['common.loading']()}</span>
			<Skeleton class="h-8 w-full" />
			<Skeleton class="h-12 w-full" />
			<Skeleton class="h-12 w-full" />
		</div>
	{/if}
</div>
