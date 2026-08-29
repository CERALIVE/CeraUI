<script lang="ts">
import { rtlLanguages } from '@ceraui/i18n';
import { getLocale, m } from '@ceraui/i18n/svelte';
import { RefreshCw, Smartphone, WifiOff } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
import { manualConnectionCheck } from '$lib/stores/offline-state.svelte';

// RTL support (for future enhancements)
const _isRTL = $derived(rtlLanguages.includes(getLocale()));

let isCheckingConnection = $state(false);
let connectionCheckFailed = $state(false);

async function handleRetry() {
	isCheckingConnection = true;
	connectionCheckFailed = false;

	try {
		// Try to manually check connection
		const success = await manualConnectionCheck();

		if (!success) {
			// Connection still failed
			connectionCheckFailed = true;
			// Reset the failed state after 3 seconds
			setTimeout(() => {
				connectionCheckFailed = false;
			}, 3000);
		}
		// If success, manualConnectionCheck will handle the reload
	} catch (error) {
		console.error('Connection check failed:', error);
		connectionCheckFailed = true;
		setTimeout(() => {
			connectionCheckFailed = false;
		}, 3000);
	} finally {
		isCheckingConnection = false;
	}
}

function goBack() {
	if (window.history.length > 1) {
		window.history.back();
	} else {
		window.location.href = '/';
	}
}
</script>

<div class="bg-background flex min-h-screen items-center justify-center p-4" data-testid="offline-page">
	<Card class="mx-auto w-full max-w-md">
		<CardHeader class="text-center">
			<div class="bg-muted mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full">
				<WifiOff class="text-muted-foreground h-8 w-8" />
			</div>
			<CardTitle class="text-xl">{m["offline.title"]()}</CardTitle>
			<CardDescription>{m["offline.description"]()}</CardDescription>
		</CardHeader>
		<CardContent class="space-y-4">
			<div class="text-muted-foreground space-y-2 text-sm">
				<p>{m["offline.checkTitle"]()}</p>
				<ul class="ml-2 list-inside list-disc space-y-1">
					<li>{m["offline.checkWifi"]()}</li>
					<li>{m["offline.checkNetwork"]()}</li>
					<li>{m["offline.checkDevice"]()}</li>
				</ul>
			</div>

			<div class="flex flex-col gap-2">
				<Button
					class="w-full"
					disabled={isCheckingConnection}
					onclick={handleRetry}
					variant={connectionCheckFailed ? 'destructive' : 'default'}
				>
					<RefreshCw class="mr-2 h-4 w-4 {isCheckingConnection ? 'animate-spin' : ''}" />
					{#if isCheckingConnection}
						{m["offline.checking"]()}
					{:else if connectionCheckFailed}
						{m["offline.checkFailed"]()}
					{:else}
						{m["offline.tryAgain"]()}
					{/if}
				</Button>
				<Button class="w-full" onclick={goBack} variant="outline">{m["offline.goBack"]()}</Button>
			</div>

			<div class="border-t pt-4">
				<div class="text-muted-foreground flex items-center gap-2 text-xs">
					<Smartphone class="h-4 w-4" />
					<span>{m["offline.installNote"]()}</span>
				</div>
			</div>
		</CardContent>
	</Card>
</div>
