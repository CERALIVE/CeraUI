<script lang="ts">
import type { WithoutChild } from 'bits-ui';
import * as FormPrimitive from 'formsnap';

import { cn } from '$lib/utils.js';

let { ref = $bindable(null), class: className, ...restProps }: WithoutChild<FormPrimitive.DescriptionProps> = $props();
</script>

<FormPrimitive.Description bind:ref class={cn('text-muted-foreground text-[0.8rem]', className)} {...restProps} />
