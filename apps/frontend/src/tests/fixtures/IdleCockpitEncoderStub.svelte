<!--
  IdleCockpitEncoderStub.svelte: stand-in for IdleCockpit that only offers the
  encoder row's edit, so a test can open LiveView's EncoderDialog.
-->
<script lang="ts">
let { onOpenEncoder }: { onOpenEncoder?: () => void } = $props();
</script>

<button data-testid="open-encoder" onclick={() => onOpenEncoder?.()} type="button">Encoder</button>
