<script lang="ts">
import { getLocale, m } from '@ceraui/i18n/svelte';
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
let customTitle = $state(m["devtools.customTitle"]());
let customDescription = $state(m["devtools.customDescription"]());
let toastDuration = $state(4000);

// Update input values when locale changes
$effect(() => {
	// Subscribe to locale changes to update default input values
	const _currentLocale = getLocale(); // This creates a dependency on locale changes

	// Reset input values to new locale defaults if they haven't been modified by user
	if (customTitle === m["devtools.customTitle"]()) {
		customTitle = m["devtools.customTitle"]();
	}
	if (customDescription === m["devtools.customDescription"]()) {
		customDescription = m["devtools.customDescription"]();
	}
});

// Toast type definitions with their configurations
const toastTypes = [
	{
		name: m["devtools.success"](),
		type: 'success',
		icon: CheckCircle2,
		color: 'text-status-success',
		bgColor: 'bg-status-success/10',
		borderColor: 'border-status-success/30',
		action: () =>
			toast.success(customTitle, { description: customDescription, duration: toastDuration }),
	},
	{
		name: m["devtools.error"](),
		type: 'error',
		icon: AlertCircle,
		color: 'text-status-error',
		bgColor: 'bg-status-error/10',
		borderColor: 'border-status-error/30',
		action: () =>
			toast.error(customTitle, { description: customDescription, duration: toastDuration }),
	},
	{
		name: m["devtools.warning"](),
		type: 'warning',
		icon: AlertTriangle,
		color: 'text-status-warning',
		bgColor: 'bg-status-warning/10',
		borderColor: 'border-status-warning/30',
		action: () =>
			toast.warning(customTitle, { description: customDescription, duration: toastDuration }),
	},
	{
		name: m["devtools.info"](),
		type: 'info',
		icon: Info,
		color: 'text-status-info',
		bgColor: 'bg-status-info/10',
		borderColor: 'border-status-info/30',
		action: () =>
			toast.info(customTitle, { description: customDescription, duration: toastDuration }),
	},
	{
		name: m["devtools.default"](),
		type: 'default',
		icon: MessageCircle,
		color: 'text-muted-foreground',
		bgColor: 'bg-muted',
		borderColor: 'border-border',
		action: () => toast(customTitle, { description: customDescription, duration: toastDuration }),
	},
	{
		name: m["devtools.loading"](),
		type: 'loading',
		icon: Loader2,
		color: 'text-status-info',
		bgColor: 'bg-status-info/10',
		borderColor: 'border-status-info/30',
		action: () => {
			const loadingToast = toast.loading(customTitle, { description: customDescription });
			// Auto-dismiss loading toast after duration
			setTimeout(() => {
				toast.dismiss(loadingToast);
				toast.success(m["devtools.loadingComplete"](), {
					description: m["devtools.loadingCompleteDesc"](),
				});
			}, toastDuration);
		},
	},
];

// Preset toast examples
const presetToasts = [
	{
		name: m["devtools.networkError"](),
		type: 'error',
		title: m["devtools.connectionFailed"](),
		description: m["devtools.connectionFailedDesc"](),
		action: () =>
			toast.error(m["devtools.connectionFailed"](), {
				description: m["devtools.connectionFailedDesc"](),
				duration: 5000,
			}),
	},
	{
		name: m["devtools.settingsSaved"](),
		type: 'success',
		title: m["devtools.settingsUpdated"](),
		description: m["devtools.settingsUpdatedDesc"](),
		action: () =>
			toast.success(m["devtools.settingsUpdated"](), {
				description: m["devtools.settingsUpdatedDesc"](),
				duration: 3000,
			}),
	},
	{
		name: m["devtools.updateAvailable"](),
		type: 'info',
		title: m["devtools.newVersionAvailable"](),
		description: m["devtools.newVersionDesc"](),
		action: () =>
			toast.info(m["devtools.newVersionAvailable"](), {
				description: m["devtools.newVersionDesc"](),
				duration: 8000,
			}),
	},
	{
		name: m["devtools.lowBattery"](),
		type: 'warning',
		title: m["devtools.batteryLow"](),
		description: m["devtools.batteryLowDesc"](),
		action: () =>
			toast.warning(m["devtools.batteryLow"](), {
				description: m["devtools.batteryLowDesc"](),
				duration: 6000,
			}),
	},
];

// Action toasts with buttons
function showActionToast() {
	toast(m["devtools.confirmAction"](), {
		description: m["devtools.confirmActionDesc"](),
		action: {
			label: m["devtools.delete"](),
			onClick: () => toast.success(m["devtools.itemDeletedSuccess"]()),
		},
		cancel: {
			label: m["devtools.cancel"](),
			onClick: () => toast.info(m["devtools.actionCancelled"]()),
		},
		duration: 10000,
	});
}

function showPersistentToast() {
	toast.error(m["devtools.criticalError"](), {
		description: m["devtools.criticalErrorDesc"](),
		duration: Infinity,
		action: {
			label: m["devtools.dismiss"](),
			onClick: () => toast.dismiss(),
		},
	});
}

function dismissAllToasts() {
	toast.dismiss();
}
</script>

<Card.Root class="overflow-hidden">
	<Card.Header>
		<Card.Title class="flex items-center gap-2">
			<MessageCircle class="h-5 w-5 text-primary" />
			{m["devtools.toastNotificationTester"]()}
		</Card.Title>
		<Card.Description>
			{m["devtools.testDifferentTypes"]()}
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-6 pb-6">
		<!-- Custom Toast Configuration -->
		<div class="bg-muted/50 space-y-4 rounded-lg border p-4">
			<div class="text-sm font-medium">{m["devtools.customToastConfig"]()}</div>

			<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
				<div class="space-y-2">
					<Label class="text-xs" for="toast-title">{m["devtools.title"]()}</Label>
					<Input
						id="toast-title"
						class="text-sm"
						placeholder="Toast title..."
						bind:value={customTitle}
					/>
				</div>

				<div class="space-y-2">
					<Label class="text-xs" for="toast-duration">{m["devtools.toastDuration"]()}</Label>
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
				<Label class="text-xs" for="toast-description">{m["devtools.description"]()}</Label>
				<Textarea
					id="toast-description"
					class="resize-none text-sm"
					placeholder="Toast description..."
					rows={2}
					bind:value={customDescription}
				/>
			</div>
		</div>

		<!-- Toast Type Buttons -->
		<div class="space-y-3">
			<div class="text-sm font-medium">{m["devtools.toastTypes"]()}</div>
			<div class="grid grid-cols-2 gap-2 md:grid-cols-3">
				{#each toastTypes as toastType}
				<Button
					class={`${toastType.bgColor} ${toastType.borderColor} transition-all duration-200 hover:opacity-80`}
					onclick={toastType.action}
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
			<div class="text-sm font-medium">{m["devtools.presetExamples"]()}</div>
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
			<div class="text-sm font-medium">{m["devtools.specialToastActions"]()}</div>
			<div class="flex flex-wrap gap-2">
				<Button
					class="border-status-info/30 bg-status-info/10"
					onclick={showActionToast}
					size="sm"
					variant="outline"
				>
					<CheckCircle2 class="mr-2 h-4 w-4 text-status-info" />
					<span class="text-status-info">{m["devtools.actionToast"]()}</span>
				</Button>

				<Button
					class="border-status-warning/30 bg-status-warning/10"
					onclick={showPersistentToast}
					size="sm"
					variant="outline"
				>
					<AlertTriangle class="mr-2 h-4 w-4 text-status-warning" />
					<span class="text-status-warning">{m["devtools.persistent"]()}</span>
				</Button>

				<Button
					aria-label="Dismiss all active toast notifications"
					class="border-status-error/30 bg-status-error/10"
					onclick={dismissAllToasts}
					size="sm"
					variant="outline"
				>
					<X class="mr-2 h-4 w-4 text-status-error" />
					<span class="text-status-error">{m["devtools.dismissAll"]()}</span>
				</Button>
			</div>
		</div>

		<!-- Testing Tips -->
		<div class="text-muted-foreground bg-muted/50 space-y-1 rounded-lg p-3 text-xs" role="note">
			<div class="font-medium">{m["devtools.testingTips"]()}</div>
			<div>• {m["devtools.testingTip1"]()}</div>
			<div>• {m["devtools.testingTip2"]()}</div>
			<div>• {m["devtools.testingTip3"]()}</div>
			<div>• {m["devtools.testingTip4"]()}</div>
			<div>• {m["devtools.testingTip5"]()}</div>
		</div>
	</Card.Content>
</Card.Root>
