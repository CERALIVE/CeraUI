<!--
  Test harness for the guaranteed minimum baseline.

  It mounts the WHOLE section set the way a dialog will — identity, connection
  (carrying the unavailability statement), signal, SIM and diagnostics — from
  one `deriveModemSections` result, so the baseline can be asserted against the
  real rendered card rather than against the model that feeds it.
-->
<script lang="ts">
import ConnectionStateBlock from '../ConnectionStateBlock.svelte';
import DiagnosticsBlock from '../DiagnosticsBlock.svelte';
import IdentityBlock from '../IdentityBlock.svelte';
import SignalBlock from '../SignalBlock.svelte';
import SimBlock from '../SimBlock.svelte';
import type { ModemSectionSet, ResolvedDiagnosticRow } from '../types';

interface Props {
	sections: ModemSectionSet;
	extraDiagnostics?: readonly ResolvedDiagnosticRow[];
}

let { sections, extraDiagnostics = [] }: Props = $props();
</script>

<div data-testid="harness-card">
	<IdentityBlock identity={sections.identity} />
	<ConnectionStateBlock
		connection={sections.connection}
		unavailability={sections.unavailability}
	/>
	<SignalBlock signal={sections.signal} />
	<SimBlock sim={sections.sim} />
	<DiagnosticsBlock diagnostics={sections.diagnostics} extra={extraDiagnostics} />
</div>
