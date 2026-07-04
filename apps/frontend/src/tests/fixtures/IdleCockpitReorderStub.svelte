<!--
  IdleCockpitReorderStub.svelte — stand-in for IdleCockpit that surfaces the
  `onReorderSource` callback as a clickable button so LiveView's internal
  `handleReorderSource` (the source_preference field-lock write) can be driven from
  a component test. The real IdleCockpit renders SourceSection whose capture-row
  reorder buttons invoke this same callback; here we short-circuit to one button
  that moves `cam-b` up, matching the test's seeded device order.
-->
<script lang="ts">
const props: {
	onReorderSource?: (id: string, direction: 'up' | 'down') => void;
} = $props();
</script>

<div data-testid="idle-cockpit">
	<button
		data-testid="stub-reorder-cam-b-up"
		onclick={() => props.onReorderSource?.('cam-b', 'up')}
		type="button">reorder cam-b up</button
	>
</div>
