<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Loader2 } from '@lucide/svelte';
import { AlertDialog as AlertDialogDefault, type WithoutChild } from 'bits-ui';
import type { Snippet } from 'svelte';

import * as AlertDialog from '$lib/components/ui/alert-dialog/index';
import { type ButtonVariant, buttonVariants } from '$lib/components/ui/button';
import { cn } from '$lib/utils';

interface Props extends AlertDialogDefault.RootProps {
	class?: string;
	extraButtonClasses?: string;
	buttonClasses?: string;
	buttonText?: string;
	icon?: Snippet;
	iconPosition?: 'right' | 'left';
	hideCancelButton?: boolean;
	dialogTitle?: Snippet;
	title?: string;
	disabledConfirmButton?: boolean;
	description?: Snippet;
	cancelButtonText?: string;
	confirmButtonText?: string;
	oncancel?: () => unknown;
	/**
	 * Confirm handler. May be synchronous OR return a Promise. When it returns a
	 * Promise the dialog enters a loading state: the confirm button is disabled
	 * and shows a spinner while the promise is pending, and the dialog only
	 * closes once the promise settles (resolve OR reject). Synchronous handlers
	 * keep the original immediate-close behaviour. `disabledConfirmButton`
	 * remains for static, caller-driven disabling independent of this loading
	 * state.
	 */
	onconfirm?: () => unknown | Promise<unknown>;
	contentProps?: WithoutChild<AlertDialogDefault.ContentProps>;
	/** Confirm action button style; use `"destructive"` for reboot, power off, etc. */
	confirmVariant?: Extract<ButtonVariant, 'default' | 'destructive'>;
}

let {
	open = $bindable(false),
	extraButtonClasses,
	buttonClasses,
	icon,
	iconPosition,
	hideCancelButton = false,
	oncancel,
	onconfirm,
	cancelButtonText,
	confirmButtonText,
	confirmVariant = 'default',
	class: className,
	children,
	buttonText,
	contentProps,
	title,
	disabledConfirmButton = false,
	dialogTitle,
	description,
	...restProps
}: Props = $props();

// In-flight latch for an async `onconfirm`. While a returned promise is pending
// the confirm button is disabled + shows a spinner, and the dialog stays open;
// it closes only once the promise settles. Synchronous confirms never set this.
let confirmPending = $state(false);

function isPromise(value: unknown): value is Promise<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { then?: unknown }).then === 'function'
	);
}

function handleConfirm(event: MouseEvent) {
	// Statically disabled or already awaiting a confirm: ignore and hold the
	// dialog open (a second click must never double-fire the RPC).
	if (disabledConfirmButton || confirmPending) {
		event.preventDefault();
		return;
	}

	const result = onconfirm?.();

	if (isPromise(result)) {
		// Async path: drive the loading state and close only after the promise
		// SETTLES — on resolve AND on reject. `.then(settle, settle)` settles on
		// both outcomes without re-throwing, so a rejected OS-action never becomes
		// an unhandled rejection here; surfacing the error (toast) is the caller's
		// concern. `preventDefault` is defensive (the Action primitive carries no
		// auto-close of its own; the dialog's open state is owned here).
		event.preventDefault();
		confirmPending = true;
		const settle = () => {
			confirmPending = false;
			open = false;
		};
		result.then(settle, settle);
		return;
	}

	// Synchronous path: preserve the original immediate-close behaviour.
	open = false;
}

// Modern animation classes following your app's patterns
const triggerClasses = $derived(
	cn(
		'group relative overflow-hidden transition-all duration-300',
		'shadow-sm hover:shadow-md',
		iconPosition === 'left' ? 'flex-row-reverse' : '',
		buttonVariants({ variant: 'default' }),
		extraButtonClasses,
		buttonClasses,
	),
);

const overlayClasses =
	'fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200';

const contentClasses = $derived(
	cn(
		'fixed left-1/2 top-1/2 z-[100] w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
		'max-h-[90vh] overflow-hidden flex flex-col',
		'rounded-2xl border border-border bg-card text-card-foreground shadow-xl',
		'data-[state=open]:animate-in data-[state=closed]:animate-out',
		'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
		'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
		'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
		'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
		'duration-200',
		className,
	),
);

const headerClasses = 'flex-1 overflow-y-auto space-y-3 p-6 pb-4';
const titleClasses = 'text-lg font-semibold leading-tight text-foreground';
const descriptionClasses = 'text-sm text-muted-foreground leading-relaxed';

const footerClasses = 'flex-shrink-0 flex flex-col-reverse gap-3 p-6 sm:flex-row sm:justify-end';

const cancelButtonClasses = cn(
	buttonVariants({ variant: 'outline' }),
	'h-10 min-w-[80px] rounded-lg px-4 py-2',
);

const confirmButtonClasses = $derived(
	cn(
		buttonVariants({
			variant: confirmVariant === 'destructive' ? 'destructive' : 'default',
		}),
		'h-10 min-w-[80px] rounded-lg px-4 py-2',
		'inline-flex items-center justify-center gap-2',
		disabledConfirmButton || confirmPending ? 'cursor-not-allowed' : 'cursor-pointer',
	),
);
</script>

<AlertDialog.Root {...restProps} bind:open>
	<AlertDialog.Trigger class={triggerClasses} {title}>
		<span class="relative z-10 flex items-center gap-2">
			{#if icon && iconPosition === 'left'}
				{@render icon()}
			{/if}
			{buttonText ?? ''}
			{#if icon && iconPosition !== 'left'}
				{@render icon()}
			{/if}
		</span>
	</AlertDialog.Trigger>

	<AlertDialog.Portal>
		<AlertDialog.Overlay class={overlayClasses} />
		<AlertDialog.Content {...contentProps} class={contentClasses}>
			<AlertDialog.Header class={headerClasses}>
				{#if dialogTitle}
					<AlertDialog.Title class={titleClasses}>
						{@render dialogTitle()}
					</AlertDialog.Title>
				{/if}
				{#if description}
					<AlertDialog.Description class={descriptionClasses}>
						{@render description()}
					</AlertDialog.Description>
				{/if}
				{#if children}
					{@render children()}
				{/if}
			</AlertDialog.Header>

			<AlertDialog.Footer class={footerClasses}>
				{#if !hideCancelButton}
					<AlertDialog.Cancel class={cancelButtonClasses} onclick={() => oncancel?.()}>
						{cancelButtonText ?? $LL.dialog.cancel()}
					</AlertDialog.Cancel>
				{/if}

				<AlertDialog.Action
					class={confirmButtonClasses}
					aria-busy={confirmPending}
					disabled={disabledConfirmButton || confirmPending}
					onclick={handleConfirm}
				>
					{#if confirmPending}
						<Loader2 class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
					{/if}
					{confirmButtonText ?? $LL.dialog.continue()}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
