<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Play, Square } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { cn } from '$lib/utils';

interface Props {
	isStreaming: boolean;
	onStart: () => void;
	onStop: () => void;
	disabled?: boolean;
	variant?: 'sticky' | 'floating';
}

const { isStreaming, onStart, onStop, disabled = false, variant = 'floating' }: Props = $props();

const handleStart = () => {
	if (!disabled) {
		onStart();
	}
};

const handleStop = () => {
	if (window.stopStreamingWithNotificationClear) {
		window.stopStreamingWithNotificationClear();
	} else {
		import('$lib/helpers/SystemHelper').then((module) => {
			module.stopStreaming();
		});
	}
	onStop();
};
</script>

{#if variant === 'floating'}
	<!-- Floating Action Button at Bottom -->
	<div class="fixed right-0 bottom-0 left-0 z-50 p-4 pb-6 sm:pb-4">
		<div class="mx-auto max-w-md">
			<!-- Glassmorphism backdrop -->
			<div class="bg-card/80 rounded-2xl border p-3 shadow-2xl backdrop-blur-xl">
				{#if isStreaming}
					<Button
						class={cn(
							'group relative w-full overflow-hidden rounded-xl py-6 text-lg font-semibold shadow-lg transition-all duration-300',
							'bg-gradient-to-r from-amber-500 to-orange-500',
							'hover:from-amber-600 hover:to-orange-600',
							'hover:shadow-xl hover:shadow-amber-500/25',
						)}
						onclick={handleStop}
						size="lg"
						type="button"
					>
						<!-- Animated background pulse for streaming state -->
						<div
							class="absolute inset-0 animate-pulse bg-gradient-to-r from-amber-400/20 to-orange-400/20"
						></div>

						<div class="relative flex items-center justify-center gap-3">
							<div class="relative">
								<Square class="h-6 w-6 transition-transform group-hover:scale-110" />
								<!-- Recording indicator dot -->
								<div
									class="absolute -top-1 -right-1 h-3 w-3 animate-pulse rounded-full bg-white"
								></div>
							</div>
							<span>{$LL.settings.stopStreaming()}</span>
						</div>
					</Button>
				{:else}
					<Button
						class={cn(
							'group w-full rounded-xl py-6 text-lg font-semibold shadow-lg transition-all duration-300',
							'bg-gradient-to-r from-emerald-500 to-teal-600',
							'hover:from-emerald-600 hover:to-teal-700',
							'hover:shadow-xl hover:shadow-emerald-500/25',
							disabled && 'cursor-not-allowed opacity-50',
						)}
						{disabled}
						onclick={handleStart}
						size="lg"
						type="button"
					>
						<div class="flex items-center justify-center gap-3">
							<Play
								class="h-6 w-6 transition-transform group-hover:translate-x-0.5 group-hover:scale-110"
							/>
							<span>{$LL.settings.startStreaming()}</span>
						</div>
					</Button>

					{#if disabled}
						<p class="text-muted-foreground mt-2 text-center text-sm">
							{$LL.settings.completeRequiredFields()}
						</p>
					{/if}
				{/if}
			</div>
		</div>
	</div>

	<!-- Spacer to prevent content from being hidden behind floating button -->
	<div class="h-28 sm:h-24"></div>
{:else}
	<!-- Sticky Header variant (original) -->
	<div class="bg-background/95 sticky top-0 z-10 border-b p-6 pb-4 backdrop-blur-sm">
		<div class="mx-auto max-w-4xl">
			{#if isStreaming}
				<Button
					class="group w-full bg-gradient-to-r from-amber-500 to-orange-500 shadow-lg transition-all duration-200 hover:from-amber-600 hover:to-orange-600"
					onclick={handleStop}
					size="lg"
					type="button"
				>
					<Square class="mr-2 h-5 w-5 transition-transform group-hover:scale-110" />
					{$LL.settings.stopStreaming()}
				</Button>
			{:else}
				<Button
					class="group w-full bg-gradient-to-r from-emerald-600 to-teal-600 shadow-lg transition-all duration-200 hover:from-emerald-700 hover:to-teal-700"
					{disabled}
					onclick={handleStart}
					size="lg"
					type="button"
				>
					<Play class="mr-2 h-5 w-5 transition-transform group-hover:scale-110" />
					{$LL.settings.startStreaming()}
				</Button>
			{/if}

			{#if disabled}
				<p class="text-muted-foreground mt-2 text-center text-sm">
					{$LL.settings.completeRequiredFields()}
				</p>
			{/if}
		</div>
	</div>
{/if}
