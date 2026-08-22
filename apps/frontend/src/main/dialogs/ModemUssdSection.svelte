<!--
  ModemUssdSection.svelte — the USSD dialogue, the one capability whose backend
  was complete and whose UI was a capability-gate row and nothing else.

  ── IT IS A SESSION, SO IT CARRIES A SECOND MACHINE ─────────────────────────

  Every other gated module on this dialog is a SETTING: the four-state ladder
  answers "may this control be offered" and the control is then a switch. USSD is
  a dialogue the NETWORK holds open against the subscriber's single slot, so the
  ladder is necessary and not sufficient — it has no vocabulary for "the carrier
  asked a question and is waiting". `lib/modem/ussd-session.ts` is that second
  machine, kept pure so every phase and every refusal is testable without
  mounting anything, and mirrored from the device's own so the surface refuses a
  doomed verb instead of spending a round-trip to be told.

  ── WHY THE SURFACE LIVES IN `children`, NOT IN `control` ───────────────────

  `CapabilitySection` SUPPRESSES `children` at `blocked`, and here the children
  ARE the dialogue. So this follows the notepad's third documented pattern
  verbatim — route `absent`/`unknown`/`available` through the primitive and keep
  the standing-refusal rendering local — because a `blocked` view would take the
  dialogue off screen at exactly the moment the operator needs to read why it
  stopped. The gate that matters is unchanged and is the primitive's: a modem
  with no `ussd` claim renders ZERO nodes.

  ── NOTHING HERE ENDS IN A SPINNER ──────────────────────────────────────────

  `working` is always followed by a terminal phase. The device closes an
  unanswered dialogue at its own bound and reports `closed`/`timed-out`, which
  arrives here as the `unknown` outcome band — "nobody answered, and whether it
  acted is unknown". That is the honest third answer, and it is why this surface
  never auto-retries: a retry would open a SECOND dialogue against a slot whose
  state nobody knows.

  ── THE CARRIER'S TEXT IS HELD HERE AND NOWHERE ELSE ────────────────────────

  A USSD dialogue is how a prepaid line is topped up, so the command carries
  voucher codes and the reply carries balances and one-time codes. Both are
  rendered — that is the operator's whole reason for asking — and neither is
  logged, toasted, put in a `title`, or interpolated into any key or message.
  `AppDialog` mounts its children only while open, so closing the dialog
  unmounts this component and drops both, which makes the retention bound a
  property of the mount rather than of a cleanup somebody has to remember.
-->
<script lang="ts">
import { m, resolveMessageKey as t } from '@ceraui/i18n/svelte';
import type {
	ModemUssdOutput,
	SupportClaimState,
	UssdSessionSnapshot,
} from '@ceraui/rpc/schemas';
import { Loader2, MessageSquareMore, Send } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { type MutationOutcome, mutationOutcome } from '$lib/modem/mutation-outcome';
import { CapabilitySection } from '$lib/modem/sections';
import {
	canCancelUssd,
	canInitiateUssd,
	canRespondUssd,
	isNetworkPolicyRefusal,
	isUssdDialogueLive,
	isValidUssdCommand,
	isValidUssdResponse,
	ussdCapabilityView,
	ussdOutcomeView,
	ussdRefusalKey,
	ussdSurfacePhase,
} from '$lib/modem/ussd-session';
import { rpc } from '$lib/rpc';

interface Props {
	/** The device selector every USSD procedure takes. */
	deviceId: string;
	claim: SupportClaimState | undefined;
}

let { deviceId, claim }: Props = $props();

const capability = $derived(ussdCapabilityView(claim));

let session = $state<UssdSessionSnapshot | undefined>(undefined);
let busy = $state(false);
/**
 * The carrier's last reply. Local, never persisted, never logged, and dropped
 * on unmount with the component — see the header.
 */
let reply = $state<string | undefined>(undefined);
/**
 * A refusal that STANDS: the last verb (or the read) was refused for a reason
 * that will answer identically until something about the device changes. It
 * disables the form and states itself on screen, which is CT-2's treatment
 * reached without discarding the dialogue.
 */
let standingRefusal = $state<string | undefined>(undefined);
let outcome = $state<MutationOutcome | undefined>(undefined);

let command = $state('');
let response = $state('');

const phase = $derived(ussdSurfacePhase(session));
const dialogueLive = $derived(isUssdDialogueLive(session));
const policyRefused = $derived(isNetworkPolicyRefusal(standingRefusal));

/**
 * The refusal shown beside the form. A NETWORK-POLICY refusal is deliberately
 * NOT rendered here — it gets its own band below, because "your carrier does not
 * carry this here" is a different kind of statement from "the device refused"
 * and must not read as a device fault.
 */
const formRefusalKey = $derived(
	standingRefusal !== undefined && !policyRefused
		? ussdRefusalKey(standingRefusal)
		: undefined,
);

/**
 * A second `initiate` is refused HERE, before the RPC — the dialogue holds the
 * subscriber's single network-side slot, so the only possible answer is
 * `session-busy` and dispatching it spends a round-trip to be told so.
 */
const initiateBlockedKey = $derived(
	dialogueLive
		? 'network.modem.ussd.busy'
		: (formRefusalKey ?? undefined),
);

const canSendCommand = $derived(
	!busy &&
		canInitiateUssd(session) &&
		standingRefusal === undefined &&
		isValidUssdCommand(command),
);
const canSendResponse = $derived(
	!busy && canRespondUssd(session) && isValidUssdResponse(response),
);
const canClose = $derived(!busy && canCancelUssd(session));

function applyVerbResult(result: ModemUssdOutput, appliedKey?: string): void {
	session = result.session ?? session;
	if (result.ussdReply !== undefined) reply = result.ussdReply;

	if (result.success) {
		standingRefusal = undefined;
		// The SESSION outcome outranks the verb's own: a dialogue that closed says
		// how it closed, and that is the sentence the operator needs. A verb that
		// merely advanced a live dialogue reports itself instead.
		const ended = ussdOutcomeView(result.session);
		outcome =
			ended !== undefined
				? mutationOutcome(ended.kind, t(ended.messageKey))
				: appliedKey === undefined
					? undefined
					: mutationOutcome('applied', t(appliedKey));
		if (ended?.refusal !== undefined) standingRefusal = ended.refusal;
		return;
	}

	const token = result.error ?? result.mutationRefusal ?? 'transport-failed';
	standingRefusal = token;
	const ended = ussdOutcomeView(result.session);
	outcome =
		ended !== undefined
			? mutationOutcome(ended.kind, t(ended.messageKey))
			: mutationOutcome('refused', t(ussdRefusalKey(token)));
}

function failClosed(): void {
	standingRefusal = 'transport-failed';
	outcome = mutationOutcome('refused', t(ussdRefusalKey('transport-failed')));
}

async function read(): Promise<void> {
	const requested = deviceId;
	try {
		const result = await rpc.modems.getUssd({ device: deviceId });
		// A close/reopen onto another modem while this was in flight must not adopt
		// the previous device's dialogue.
		if (requested !== deviceId) return;
		if (result.success) {
			session = result.session;
			standingRefusal = undefined;
		} else if (result.error !== undefined) {
			standingRefusal = result.error;
		}
	} catch {
		// A failed READ claims nothing about the device: the capability ladder
		// already withholds the control until the claim reaches `capable`, so an
		// unreachable read must not additionally invent a refusal.
	}
}

async function send(): Promise<void> {
	if (!canSendCommand) return;
	// Cleared BEFORE the await, so the code an operator typed — routinely a
	// voucher — is out of the DOM the instant it is dispatched and can never be
	// echoed back into a heading, a toast or a retry affordance.
	const ussdCommand = command;
	command = '';
	busy = true;
	outcome = undefined;
	reply = undefined;
	try {
		applyVerbResult(await rpc.modems.ussdInitiate({ device: deviceId, ussdCommand }));
	} catch {
		failClosed();
	} finally {
		busy = false;
	}
}

async function answer(): Promise<void> {
	if (!canSendResponse) return;
	const ussdResponse = response;
	response = '';
	busy = true;
	outcome = undefined;
	try {
		applyVerbResult(await rpc.modems.ussdRespond({ device: deviceId, ussdResponse }));
	} catch {
		failClosed();
	} finally {
		busy = false;
	}
}

async function close(): Promise<void> {
	if (!canClose) return;
	busy = true;
	outcome = undefined;
	try {
		applyVerbResult(
			await rpc.modems.ussdCancel({ device: deviceId }),
			'network.modem.ussd.outcome.cancelled',
		);
	} catch {
		failClosed();
	} finally {
		busy = false;
	}
}

/**
 * Start over. Drops the previous dialogue's reply with it: a balance left on
 * screen under a fresh command form is the previous question's answer presented
 * as this one's.
 */
function startOver(): void {
	session = undefined;
	reply = undefined;
	outcome = undefined;
	standingRefusal = undefined;
	response = '';
}

/*
  READ ON MOUNT, and it is load-bearing rather than cosmetic. The device's
  capability evidence for USSD is filled BY this read, and every verb is gated on
  it — so without it the first dialogue on a fresh boot is refused
  `module_unavailable` no matter what the hardware can do. `AppDialog` mounts its
  children only while open, so this runs once per open of the modem dialog.
*/
$effect(() => {
	void read();
});
</script>

<CapabilitySection
	name="modem-ussd"
	view={capability}
	{busy}
	{outcome}
	icon={MessageSquareMore}
	title={m['network.modem.ussd.title']()}
	description={m['network.modem.ussd.description']()}
>
	<div
		class="space-y-3"
		data-testid="modem-ussd-session"
		data-session-phase={phase}
		data-session-state={session?.state ?? 'idle'}
		data-session-outcome={session?.outcome ?? ''}
	>
		<!--
		  THE NETWORK-POLICY BAND. `lte-only-unsupported` is the one refusal in the
		  vocabulary that says nothing about the hardware, so it gets its own band
		  and its own words: the modem is fine, the carrier simply does not carry
		  USSD on a data-only registration. Rendered as a generic failure it would
		  send an operator hunting for a firmware fix for a carrier decision.
		-->
		{#if policyRefused}
			<div
				class="border-status-warning/40 bg-status-warning/10 space-y-1 rounded-md border p-2.5"
				data-testid="modem-ussd-policy"
				data-ussd-policy="lte-only-unsupported"
				role="status"
			>
				<p class="text-sm font-medium">{m['network.modem.ussd.policyTitle']()}</p>
				<p class="text-muted-foreground text-xs leading-relaxed">
					{m['network.modem.ussd.policyBody']()}
				</p>
			</div>
		{/if}

		{#if phase === 'working'}
			<!--
			  BOUNDED, and the copy says so. The device closes an unanswered dialogue
			  itself, so this state always resolves — stating that is what separates
			  it from a spinner an operator has no reason to trust.
			-->
			<p
				class="text-muted-foreground flex items-start gap-2 text-xs"
				data-testid="modem-ussd-working"
				role="status"
			>
				<Loader2 class="mt-px size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
				<span>
					{m['network.modem.ussd.working']()}
					<span class="block">{m['network.modem.ussd.workingHint']()}</span>
				</span>
			</p>
		{/if}

		{#if reply !== undefined}
			<!--
			  The carrier's own text. The ONE place it is rendered, marked so a gate
			  can assert it appears nowhere else. `whitespace-pre-line` because a USSD
			  menu is line-oriented and collapsing it makes the options unreadable.
			-->
			<div class="bg-muted/40 space-y-1 rounded-md border p-2.5">
				<p class="text-xs font-medium">
					{phase === 'awaiting-reply'
						? m['network.modem.ussd.questionTitle']()
						: m['network.modem.ussd.replyTitle']()}
				</p>
				<p
					class="text-sm leading-relaxed break-words whitespace-pre-line"
					data-testid="modem-ussd-reply"
				>{reply}</p>
			</div>
		{/if}

		{#if phase === 'awaiting-reply'}
			<div class="space-y-1.5">
				<Label class="text-xs" for="modem-ussd-response">
					{m['network.modem.ussd.responseLabel']()}
				</Label>
				<div class="flex items-start gap-2">
					<Input
						autocomplete="off"
						bind:value={response}
						class="h-9 flex-1 font-mono text-sm"
						data-testid="modem-ussd-response"
						dir="ltr"
						id="modem-ussd-response"
						maxlength={182}
						onkeydown={(event: KeyboardEvent) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								void answer();
							}
						}}
						placeholder="1"
						type="text"
					/>
					<Button
						class="h-9 min-h-[var(--touch-target-min)] gap-1.5"
						data-testid="modem-ussd-respond"
						disabled={!canSendResponse}
						onclick={() => void answer()}
						size="sm"
						type="button"
					>
						<Send class="size-3.5" aria-hidden="true" />
						{m['network.modem.ussd.respond']()}
					</Button>
				</div>
			</div>
		{:else if phase === 'open'}
			<p class="text-muted-foreground text-xs" data-testid="modem-ussd-open-hint">
				{m['network.modem.ussd.openHint']()}
			</p>
		{:else if phase === 'idle' || phase === 'closed'}
			<div class="space-y-1.5">
				<Label class="text-xs" for="modem-ussd-command">
					{m['network.modem.ussd.commandLabel']()}
				</Label>
				<div class="flex items-start gap-2">
					<Input
						autocomplete="off"
						bind:value={command}
						class="h-9 flex-1 font-mono text-sm"
						data-testid="modem-ussd-command"
						dir="ltr"
						id="modem-ussd-command"
						maxlength={182}
						onkeydown={(event: KeyboardEvent) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								void send();
							}
						}}
						placeholder="*611#"
						type="text"
					/>
					<Button
						class="h-9 min-h-[var(--touch-target-min)] gap-1.5"
						data-testid="modem-ussd-send"
						disabled={!canSendCommand}
						onclick={() => void send()}
						size="sm"
						type="button"
					>
						<Send class="size-3.5" aria-hidden="true" />
						{m['network.modem.ussd.send']()}
					</Button>
				</div>
				<p class="text-muted-foreground/80 text-xs" data-testid="modem-ussd-command-hint">
					{m['network.modem.ussd.commandHint']()}
				</p>
			</div>
		{/if}

		<!--
		  A refusal that stands is ON SCREEN beside the control it withholds, never
		  in a `title` alone — the shipped kiosk touchscreen cannot hover.
		-->
		{#if initiateBlockedKey !== undefined && phase !== 'awaiting-reply'}
			<p class="text-status-warning text-xs" data-testid="modem-ussd-reason">
				{t(initiateBlockedKey)}
			</p>
		{/if}

		<div class="flex flex-wrap items-center gap-2">
			{#if canClose || phase === 'working'}
				<Button
					class="h-8 min-h-[var(--touch-target-min)] text-xs"
					data-testid="modem-ussd-cancel"
					disabled={!canClose}
					onclick={() => void close()}
					size="sm"
					type="button"
					variant="outline"
				>
					{m['network.modem.ussd.cancel']()}
				</Button>
			{/if}
			{#if phase === 'closed'}
				<Button
					class="h-8 min-h-[var(--touch-target-min)] text-xs"
					data-testid="modem-ussd-new"
					onclick={startOver}
					size="sm"
					type="button"
					variant="ghost"
				>
					{m['network.modem.ussd.newSession']()}
				</Button>
			{/if}
		</div>

		<p class="text-muted-foreground/80 text-xs" data-testid="modem-ussd-privacy">
			{m['network.modem.ussd.privacyNotice']()}
		</p>
	</div>
</CapabilitySection>
