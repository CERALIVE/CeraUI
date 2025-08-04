<script lang="ts">
import { AlertDialog as AlertDialogDefault, type WithoutChild } from 'bits-ui';
import type { Snippet } from 'svelte';
import { _ } from 'svelte-i18n';

import * as AlertDialog from '$lib/components/ui/alert-dialog/index';
import { buttonVariants } from '$lib/components/ui/button';
import { cn } from '$lib/utils';

type Props = AlertDialogDefault.RootProps & {
  className?: string;
  extraButtonClasses?: string;
  buttonText?: string;
  icon?: Snippet;
  iconPosition?: 'right' | 'left';
  hiddeCancelButton?: boolean;
  dialogTitle: Snippet;
  title?: string;
  disabledConfirmButton?: boolean;
  description: Snippet;
  cancelButtonText?: string;
  confirmButtonText?: string;
  oncancel?: () => unknown;
  onconfirm?: () => unknown;
  contentProps?: WithoutChild<AlertDialogDefault.ContentProps>;
};

let {
  open = $bindable(false),
  extraButtonClasses,
  icon,
  iconPosition,
  hiddeCancelButton,
  oncancel,
  onconfirm,
  cancelButtonText,
  confirmButtonText,
  class: className,
  children,
  buttonText,
  contentProps,
  title,
  disabledConfirmButton,
  dialogTitle,
  description,
  ...restProps
}: Props = $props();
</script>

<AlertDialog.Root {...restProps} bind:open>
  <AlertDialog.Trigger
    class={cn(
      iconPosition === 'left' ? 'flex-row-reverse' : '',
      buttonVariants({ variant: 'default' }),
      extraButtonClasses,
    )}
    {title}>
    {buttonText}
    {@render icon?.()}
  </AlertDialog.Trigger>
  <AlertDialog.Portal>
    <AlertDialog.Overlay />
    <AlertDialog.Content {...contentProps} class={cn(className)}>
      <AlertDialog.Header>
        <AlertDialog.Title>
          {@render dialogTitle?.()}
        </AlertDialog.Title>
        <AlertDialog.Description>
          {@render description?.()}
        </AlertDialog.Description>
        {@render children?.()}
      </AlertDialog.Header>
      <AlertDialog.Footer>
        {#if !hiddeCancelButton}
          <AlertDialog.Cancel onclick={() => oncancel?.()}
            >{cancelButtonText ?? $_('dialog.cancel')}</AlertDialog.Cancel>
        {/if}
        <AlertDialog.Action
          disabled={disabledConfirmButton}
          onclick={() => {
            onconfirm?.();
            setTimeout(() => (open = false), 20);
          }}
          >{confirmButtonText ?? $_('dialog.continue')}
        </AlertDialog.Action>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
