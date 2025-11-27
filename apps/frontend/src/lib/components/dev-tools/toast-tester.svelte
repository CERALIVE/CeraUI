<style>
/* Toast tester specific animations */
:global(.toast-demo) {
	animation: toast-demo-highlight 2s ease-in-out infinite alternate;
}

@keyframes toast-demo-highlight {
	from {
		box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.3);
	}
	to {
		box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.1);
	}
}
</style>

<script lang="ts">
import { LL, locale } from '@ceraui/i18n/svelte';
import {
	AlertCircle,
	AlertTriangle,
	CheckCircle2,
	Info,
	Loader2,
	MessageCircle,
	X,
} from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { Textarea } from '$lib/components/ui/textarea';

// Toast testing state
let customTitle = $state($LL.devtools.customTitle());
let customDescription = $state($LL.devtools.customDescription());
let toastDuration = $state(4000);
const _selectedPosition = $state('bottom-right');

// Update input values when locale changes
$effect(() => {
	// Subscribe to locale changes to update default input values
	const _currentLocale = $locale; // This creates a dependency on locale changes

	// Reset input values to new locale defaults if they haven't been modified by user
	if (customTitle === $LL.devtools.customTitle()) {
		customTitle = $LL.devtools.customTitle();
	}
	if (customDescription === $LL.devtools.customDescription()) {
		customDescription = $LL.devtools.customDescription();
	}
});

// Toast positions available in Sonner
const _toastPositions = [
	{ value: 'top-left', label: $LL.devtools.topLeft() },
	{ value: 'top-center', label: $LL.devtools.topCenter() },
	{ value: 'top-right', label: $LL.devtools.topRight() },
	{ value: 'bottom-left', label: $LL.devtools.bottomLeft() },
	{ value: 'bottom-center', label: $LL.devtools.bottomCenter() },
	{ value: 'bottom-right', label: $LL.devtools.bottomRight() },
];

// Toast type definitions with their configurations
const toastTypes = [
	{
		name: $LL.devtools.success(),
		type: 'success',
		icon: CheckCircle2,
		color: 'text-emerald-600 dark:text-emerald-400',
		bgColor: 'bg-emerald-500/10',
		borderColor: 'border-emerald-500/30',
		action: () =>
			toast.success(customTitle, { description: customDescription, duration: toastDuration }),
	},
	{
		name: $LL.devtools.error(),
		type: 'error',
		icon: AlertCircle,
		color: 'text-red-600 dark:text-red-400',
		bgColor: 'bg-red-500/10',
		borderColor: 'border-red-500/30',
		action: () =>
			toast.error(customTitle, { description: customDescription, duration: toastDuration }),
	},
	{
		name: $LL.devtools.warning(),
		type: 'warning',
		icon: AlertTriangle,
		color: 'text-amber-600 dark:text-amber-400',
		bgColor: 'bg-amber-500/10',
		borderColor: 'border-amber-500/30',
		action: () =>
			toast.warning(customTitle, { description: customDescription, duration: toastDuration }),
	},
	{
		name: $LL.devtools.info(),
		type: 'info',
		icon: Info,
		color: 'text-blue-600 dark:text-blue-400',
		bgColor: 'bg-blue-500/10',
		borderColor: 'border-blue-500/30',
		action: () =>
			toast.info(customTitle, { description: customDescription, duration: toastDuration }),
	},
	{
		name: $LL.devtools.default(),
		type: 'default',
		icon: MessageCircle,
		color: 'text-slate-600 dark:text-slate-400',
		bgColor: 'bg-slate-500/10',
		borderColor: 'border-slate-500/30',
		action: () => toast(customTitle, { description: customDescription, duration: toastDuration }),
	},
	{
		name: $LL.devtools.loading(),
		type: 'loading',
		icon: Loader2,
		color: 'text-blue-600 dark:text-blue-400',
		bgColor: 'bg-blue-500/10',
		borderColor: 'border-blue-500/30',
		action: () => {
			const loadingToast = toast.loading(customTitle, { description: customDescription });
			// Auto-dismiss loading toast after duration
			setTimeout(() => {
				toast.dismiss(loadingToast);
				toast.success($LL.devtools.loadingComplete(), {
					description: $LL.devtools.loadingCompleteDesc(),
				});
			}, toastDuration);
		},
	},
];

// Preset toast examples
const presetToasts = [
	{
		name: $LL.devtools.networkError(),
		type: 'error',
		title: $LL.devtools.connectionFailed(),
		description: $LL.devtools.connectionFailedDesc(),
		action: () =>
			toast.error($LL.devtools.connectionFailed(), {
				description: $LL.devtools.connectionFailedDesc(),
				duration: 5000,
			}),
	},
	{
		name: $LL.devtools.settingsSaved(),
		type: 'success',
		title: $LL.devtools.settingsUpdated(),
		description: $LL.devtools.settingsUpdatedDesc(),
		action: () =>
			toast.success($LL.devtools.settingsUpdated(), {
				description: $LL.devtools.settingsUpdatedDesc(),
				duration: 3000,
			}),
	},
	{
		name: $LL.devtools.updateAvailable(),
		type: 'info',
		title: $LL.devtools.newVersionAvailable(),
		description: $LL.devtools.newVersionDesc(),
		action: () =>
			toast.info($LL.devtools.newVersionAvailable(), {
				description: $LL.devtools.newVersionDesc(),
				duration: 8000,
			}),
	},
	{
		name: $LL.devtools.lowBattery(),
		type: 'warning',
		title: $LL.devtools.batteryLow(),
		description: $LL.devtools.batteryLowDesc(),
		action: () =>
			toast.warning($LL.devtools.batteryLow(), {
				description: $LL.devtools.batteryLowDesc(),
				duration: 6000,
			}),
	},
];

// Action toasts with buttons
function showActionToast() {
	toast($LL.devtools.confirmAction(), {
		description: $LL.devtools.confirmActionDesc(),
		action: {
			label: $LL.devtools.delete(),
			onClick: () => toast.success($LL.devtools.itemDeletedSuccess()),
		},
		cancel: {
			label: $LL.devtools.cancel(),
			onClick: () => toast.info($LL.devtools.actionCancelled()),
		},
		duration: 10000,
	});
}

function showPersistentToast() {
	toast.error($LL.devtools.criticalError(), {
		description: $LL.devtools.criticalErrorDesc(),
		duration: Infinity,
		action: {
			label: $LL.devtools.dismiss(),
			onClick: () => toast.dismiss(),
		},
	});
}

function dismissAllToasts() {
	toast.dismiss();
}
</script>

<Card.Root class="overflow-hidden border-purple-500/30">
	<!-- Status bar -->
	<div class="h-1 bg-gradient-to-r from-purple-500 to-violet-600"></div>

	<Card.Header>
		<Card.Title class="flex items-center gap-2">
			<div class="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-500">
				<MessageCircle class="h-4 w-4 text-white" />
			</div>
			🍞 {$LL.devtools.toastNotificationTester()}
		</Card.Title>
		<Card.Description>
			{$LL.devtools.testDifferentTypes()}
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-6">
		<!-- Custom Toast Configuration -->
		<div class="bg-muted/50 space-y-4 rounded-lg border p-4">
			<div class="text-sm font-medium">{$LL.devtools.customToastConfig()}</div>

			<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
				<div class="space-y-2">
					<Label class="text-xs" for="toast-title">{$LL.devtools.title()}</Label>
					<Input
						id="toast-title"
						class="text-sm"
						placeholder="Toast title..."
						bind:value={customTitle}
					/>
				</div>

				<div class="space-y-2">
					<Label class="text-xs" for="toast-duration">{$LL.devtools.toastDuration()}</Label>
					<Input
						id="toast-duration"
						class="text-sm"
						max="10000"
						min="1000"
						step="500"
						type="number"
						bind:value={toastDuration}
					/>
				</div>
			</div>

			<div class="space-y-2">
				<Label class="text-xs" for="toast-description">{$LL.devtools.description()}</Label>
				<Textarea
					id="toast-description"
					class="resize-none text-sm"
					placeholder="Toast description..."
					rows="2"
					bind:value={customDescription}
				/>
			</div>
		</div>

		<!-- Toast Type Buttons -->
		<div class="space-y-3">
			<div class="text-sm font-medium">{$LL.devtools.toastTypes()}</div>
			<div class="grid grid-cols-2 gap-2 md:grid-cols-3">
				{#each toastTypes as toastType}
					<Button
						class={`${toastType.bgColor} ${toastType.borderColor} transition-all duration-200 hover:opacity-80`}
						onclick={toastType.action}
						size="sm"
						variant="outline"
					>
						{@const IconComponent = toastType.icon}
						<IconComponent
							class={`mr-2 h-4 w-4 ${toastType.color} ${toastType.type === 'loading' ? 'animate-spin' : ''}`}
						/>
						<span class={toastType.color}>{toastType.name}</span>
					</Button>
				{/each}
			</div>
		</div>

		<!-- Preset Examples -->
		<div class="space-y-3">
			<div class="text-sm font-medium">{$LL.devtools.presetExamples()}</div>
			<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
				{#each presetToasts as preset}
					<Button
						class="h-auto justify-start p-3 text-left"
						onclick={preset.action}
						size="sm"
						variant="outline"
					>
						<div class="flex-1">
							<div class="text-xs font-medium">{preset.name}</div>
							<div class="text-muted-foreground truncate text-xs">{preset.title}</div>
						</div>
					</Button>
				{/each}
			</div>
		</div>

		<!-- Special Actions -->
		<div class="space-y-3">
			<div class="text-sm font-medium">{$LL.devtools.specialToastActions()}</div>
			<div class="flex flex-wrap gap-2">
				<Button
					class="border-indigo-500/30 bg-indigo-500/10"
					onclick={showActionToast}
					size="sm"
					variant="outline"
				>
					<CheckCircle2 class="mr-2 h-4 w-4 text-indigo-600 dark:text-indigo-400" />
					<span class="text-indigo-600 dark:text-indigo-400">{$LL.devtools.actionToast()}</span>
				</Button>

				<Button
					class="border-amber-500/30 bg-amber-500/10"
					onclick={showPersistentToast}
					size="sm"
					variant="outline"
				>
					<AlertTriangle class="mr-2 h-4 w-4 text-amber-600 dark:text-amber-400" />
					<span class="text-amber-600 dark:text-amber-400">{$LL.devtools.persistent()}</span>
				</Button>

				<Button
					class="border-red-500/30 bg-red-500/10"
					onclick={dismissAllToasts}
					size="sm"
					variant="outline"
				>
					<X class="mr-2 h-4 w-4 text-red-600 dark:text-red-400" />
					<span class="text-red-600 dark:text-red-400">{$LL.devtools.dismissAll()}</span>
				</Button>
			</div>
		</div>

		<!-- Testing Tips -->
		<div class="text-muted-foreground bg-muted/50 space-y-1 rounded-lg p-3 text-xs">
			<div class="font-medium">💡 {$LL.devtools.testingTips()}:</div>
			<div>• {$LL.devtools.testingTip1()}</div>
			<div>• {$LL.devtools.testingTip2()}</div>
			<div>• {$LL.devtools.testingTip3()}</div>
			<div>• {$LL.devtools.testingTip4()}</div>
			<div>• {$LL.devtools.testingTip5()}</div>
		</div>
	</Card.Content>
</Card.Root>
