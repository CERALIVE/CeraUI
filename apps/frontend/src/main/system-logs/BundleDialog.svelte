<!--
  BundleDialog.svelte: the support bundle's preview. It opens on the device's
  manifest: each section with its entries and removed values, the boots covered
  and the versions running now, and the statement that the file is reduced, not
  free of personal data. The downloaded file carries no such warning of its own,
  so this is where it is said, before Download bundle can be pressed. A refused
  preview (including the device's fail-closed identifier collision, which reads
  as READ_FAILED) offers Retry; Cancel, Escape and the close button discard a
  request still in flight.
-->
<script lang="ts">
import { getLocale, m } from '@ceraui/i18n/svelte';
import type { LogBundleManifest, VersionContext } from '@ceraui/rpc/schemas';
import { RefreshCw, ShieldAlert, TriangleAlert } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { Skeleton } from '$lib/components/ui/skeleton';
import type { SharingFlow } from '$lib/device-logs/sharing-flow.svelte';

import KeepWords from './KeepWords.svelte';

let { sharing }: { sharing: SharingFlow } = $props();

type SectionId = LogBundleManifest['sections'][number]['id'];

const SECTIONS: Record<SectionId, () => string> = {
	versions: () => m['systemLogs.sharing.bundleSectionVersions'](),
	settings: () => m['systemLogs.sharing.bundleSectionSettings'](),
	events: () => m['systemLogs.sharing.bundleSectionEvents'](),
	journal: () => m['systemLogs.sharing.bundleSectionJournal'](),
};

const VERSIONS: ReadonlyArray<[Exclude<keyof VersionContext, 'bootId'>, () => string]> = [
	['osImage', () => m['systemLogs.versions.systemImage']()],
	['slot', () => m['systemLogs.versions.slot']()],
	['board', () => m['systemLogs.versions.board']()],
	['boardModel', () => m['systemLogs.versions.boardModel']()],
	['ceraui', () => m['systemLogs.versions.ceraui']()],
	['engine', () => m['systemLogs.versions.engine']()],
	['senderVersion', () => m['systemLogs.versions.sender']()],
	['kernel', () => m['systemLogs.versions.kernel']()],
	['bun', () => m['systemLogs.versions.bun']()],
];

const PREVIEW_PROBLEM = {
	busy: () => m['systemLogs.sharing.busy'](),
	failed: () => m['systemLogs.sharing.bundleFailed'](),
};
const CREATE_PROBLEM = {
	busy: () => m['systemLogs.sharing.busy'](),
	failed: () => m['systemLogs.sharing.failed'](),
};

const locale = $derived(getLocale());
const count = (value: number) => value.toLocaleString(locale);
const status = $derived(
	sharing.bundleStep === 'previewing'
		? m['systemLogs.sharing.bundlePreparing']()
		: sharing.bundleStep === 'creating'
			? m['advanced.downloading']()
			: '',
);
</script>

{#snippet runningNow(versions: VersionContext)}
	<section class="flex flex-col gap-2" data-testid="sharing-bundle-running">
		<h3 class="text-sm font-semibold">{m['systemLogs.sharing.bundleRunning']()}</h3>
		<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
			{#each VERSIONS as [field, label] (field)}
				<dt class="text-muted-foreground">{label()}</dt>
				{#if versions[field] === null}
					<dd data-state="unknown">{m['systemLogs.versions.notReported']()}</dd>
				{:else}
					<dd class="font-mono wrap-anywhere"><bdi dir="ltr">{versions[field]}</bdi></dd>
				{/if}
			{/each}
		</dl>
	</section>
{/snippet}

<AppDialog
	bind:open={() => sharing.bundleStep !== 'closed', (open) => {
		if (!open) sharing.closeBundle();
	}}
	closeOnPrimary={false}
	onPrimary={() => void sharing.downloadBundle()}
	primaryDisabled={sharing.manifest === null}
	primaryLabel={m['systemLogs.sharing.bundleDownload']()}
	primaryLoading={sharing.bundleStep === 'creating'}
	title={m['systemLogs.sharing.bundle']()}
>
	<div class="flex flex-col gap-4 [word-break:auto-phrase] [&:lang(ko)]:break-keep [&:lang(zh)]:break-keep wrap-break-word text-pretty [&:lang(zh)]:text-balance">
		<div class="flex items-start gap-3 rounded-lg border p-3">
			<ShieldAlert aria-hidden="true" class="text-muted-foreground mt-0.5 size-4 shrink-0" />
			<p class="text-sm" data-testid="sharing-bundle-sensitive"><KeepWords text={m['systemLogs.sharing.bundleSensitive']()} /></p>
		</div>
		<p class="text-muted-foreground text-sm empty:hidden" data-testid="sharing-bundle-status" role="status">{status}</p>

		{#if sharing.bundleStep === 'previewing'}
			<div aria-hidden="true" class="flex flex-col gap-2" data-testid="sharing-bundle-loading">
				{#each [0, 1, 2, 3] as row (row)}
					<Skeleton class="h-6 w-full" />
				{/each}
			</div>
		{/if}

		{#if sharing.bundleProblem}
			<div
				class="border-status-warning/30 bg-status-warning/10 flex items-start gap-3 rounded-lg border p-3"
				data-testid="sharing-bundle-problem"
				role="alert"
			>
				<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
				<div class="flex min-w-0 flex-1 flex-col items-start gap-2">
					{#if sharing.manifest === null}
						<p class="text-sm"><KeepWords text={PREVIEW_PROBLEM[sharing.bundleProblem]()} /></p>
						<Button class="gap-1.5" onclick={() => void sharing.retryPreview()} size="sm" variant="outline">
							<RefreshCw aria-hidden="true" class="size-4" />
							{m['systemLogs.action.retry']()}
						</Button>
					{:else}
						<p class="text-sm"><KeepWords text={CREATE_PROBLEM[sharing.bundleProblem]()} /></p>
					{/if}
				</div>
			</div>
		{/if}

		{#if sharing.manifest}
			<table class="w-full text-sm">
				<thead class="text-muted-foreground text-xs">
					<tr>
						<td></td>
						<th class="ps-3 pb-1 text-end font-normal" scope="col">{m['systemLogs.sharing.bundleEntries']()}</th>
						<th class="ps-3 pb-1 text-end font-normal" scope="col">{m['systemLogs.sharing.bundleRedactions']()}</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each sharing.manifest.sections as section (section.id)}
						<tr>
							<th class="py-1.5 text-start font-normal" scope="row">{SECTIONS[section.id]()}</th>
							<td class="py-1.5 ps-3 text-end tabular-nums">{count(section.entries)}</td>
							<td class="py-1.5 ps-3 text-end tabular-nums">{count(section.redactions)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="text-muted-foreground text-xs" data-testid="sharing-bundle-boots">
				{m['systemLogs.sharing.bundleBoots']({ count: count(sharing.manifest.boots.length) })}
			</p>

			{@render runningNow(sharing.manifest.exportedBy)}
		{/if}
	</div>
</AppDialog>
