<!--
  ToasterStub.svelte — inert stand-in for the shadcn/sonner `Toaster` in the
  persistent-notice tests. Records the offset props it was handed so the mobile
  dock clearance is assertable without mounting svelte-sonner (which needs
  `mode-watcher` and a real layout).
-->
<script lang="ts" module>
export interface ToasterStubProps {
	offset?: unknown;
	mobileOffset?: unknown;
}

let lastProps: ToasterStubProps = {};

export function readToasterProps(): ToasterStubProps {
	return lastProps;
}
</script>

<script lang="ts">
const props: ToasterStubProps = $props();
$effect(() => {
	lastProps = { offset: props.offset, mobileOffset: props.mobileOffset };
});
</script>

<div data-testid="toaster-stub"></div>
