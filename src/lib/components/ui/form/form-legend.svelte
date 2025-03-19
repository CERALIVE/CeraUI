<script lang="ts">
import type { WithoutChild } from 'bits-ui';
import * as FormPrimitive from 'formsnap';

import { cn } from '$lib/utils.js';

let { ref = $bindable(null), class: className, ...restProps }: WithoutChild<FormPrimitive.LegendProps> = $props();
</script>

<FormPrimitive.Legend
  bind:ref
  {...restProps}
  class={cn('data-fs-error:text-destructive text-sm leading-none font-medium', className)} />
