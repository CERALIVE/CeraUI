<script lang="ts">
import { AlertDialog as AlertDialogDefault, type WithoutChild } from 'bits-ui';
import type { Snippet } from 'svelte';
import { _ } from 'svelte-i18n';

import * as AlertDialog from '$lib/components/ui/alert-dialog/index';
import { buttonVariants } from '$lib/components/ui/button';
import { cn } from '$lib/utils';

interface Props extends AlertDialogDefault.RootProps {
  class?: string;
  extraButtonClasses?: string;
  buttonClasses?: string;
  buttonText?: string;
  icon?: Snippet;
  iconPosition?: 'right' | 'left';
  hiddeCancelButton?: boolean;
  dialogTitle?: Snippet;
  title?: string;
  disabledConfirmButton?: boolean;
  description?: Snippet;
  cancelButtonText?: string;
  confirmButtonText?: string;
  oncancel?: () => unknown;
  onconfirm?: () => unknown;
  contentProps?: WithoutChild<AlertDialogDefault.ContentProps>;
}

let {
  open = $bindable(false),
  extraButtonClasses,
  buttonClasses,
  icon,
  iconPosition,
  hiddeCancelButton = false,
  oncancel,
  onconfirm,
  cancelButtonText,
  confirmButtonText,
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

// Modern animation classes following your app's patterns
const triggerClasses = $derived(
  cn(
    'group relative overflow-hidden transition-all duration-300',
    'shadow-lg hover:shadow-xl',
    'transform hover:scale-[1.02] active:scale-[0.98]',
    iconPosition === 'left' ? 'flex-row-reverse' : '',
    buttonVariants({ variant: 'default' }),
    extraButtonClasses,
    buttonClasses,
  ),
);

const overlayClasses =
  'fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200';

const contentClasses = $derived(
  cn(
    'fixed left-1/2 top-1/2 z-[100] w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
    'max-h-[90vh] overflow-hidden flex flex-col',
    'rounded-2xl border bg-white shadow-xl',
    'dark:bg-gray-900 dark:border-gray-700',
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
  'inline-flex h-10 min-w-[80px] items-center justify-center rounded-lg px-4 py-2 text-sm font-medium',
  'border border-input bg-background text-foreground',
  'hover:bg-accent hover:text-accent-foreground',
  'transition-all duration-200',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  'disabled:pointer-events-none disabled:opacity-50',
);

const confirmButtonClasses = $derived(
  cn(
    'inline-flex h-10 min-w-[80px] items-center justify-center rounded-lg px-4 py-2 text-sm font-medium',
    'bg-primary text-primary-foreground shadow-sm',
    'hover:bg-primary/90',
    'transition-all duration-200',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
    'disabled:pointer-events-none disabled:opacity-50',
    disabledConfirmButton ? 'cursor-not-allowed' : 'cursor-pointer',
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
        {#if !hiddeCancelButton}
          <AlertDialog.Cancel class={cancelButtonClasses} onclick={() => oncancel?.()}>
            {cancelButtonText ?? $_('dialog.cancel')}
          </AlertDialog.Cancel>
        {/if}

        <AlertDialog.Action
          class={confirmButtonClasses}
          disabled={disabledConfirmButton}
          onclick={() => {
            onconfirm?.();
            setTimeout(() => (open = false), 20);
          }}>
          {confirmButtonText ?? $_('dialog.continue')}
        </AlertDialog.Action>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
