<!--
  ShutdownMark.svelte — how a boot ended, exactly as the device classified it:
  glyph (shape and colour) plus its text label, never colour alone. Unknown has
  its own glyph, tone and data-state and is never drawn or named as clean
  (DESIGN.md CT-3). Shared by the boot picker and the Events boot separators.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { LogBootInfo } from '@ceraui/rpc/schemas';
import { Check, CircleDot, CircleHelp, TriangleAlert } from '@lucide/svelte';

type Shutdown = LogBootInfo['shutdown'];

const MARKS = {
	current: { icon: CircleDot, tone: 'text-status-info', label: () => m['systemLogs.boots.mark.current']() },
	clean: { icon: Check, tone: 'text-muted-foreground', label: () => m['systemLogs.boots.mark.clean']() },
	unclean: { icon: TriangleAlert, tone: 'text-status-warning', label: () => m['systemLogs.boots.mark.unclean']() },
	unknown: { icon: CircleHelp, tone: 'text-status-neutral', label: () => m['systemLogs.boots.mark.unknown']() },
} satisfies Record<Shutdown, unknown>;

let { shutdown }: { shutdown: Shutdown } = $props();

const mark = $derived(MARKS[shutdown]);
</script>

<span class="inline-flex min-w-0 items-center gap-1.5" data-boot-mark data-state={shutdown}>
	<mark.icon class="size-4 shrink-0 {mark.tone}" />
	<span>{mark.label()}</span>
</span>
