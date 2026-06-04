<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { AlertCircle, Eye, EyeOff, LoaderCircle } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { Checkbox } from '$lib/components/ui/checkbox';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import LocaleSelector from '$lib/components/custom/locale-selector.svelte';
import ModeToggle from '$lib/components/custom/mode-toggle.svelte';
import { deviceName, siteName } from '$lib/config';
import { getSessionExpired } from '$lib/stores/connection-ux.svelte';
import { getConnectionState } from '$lib/stores/offline-state.svelte';
import {
	getAuth,
	getNotifications,
	getStatus,
	sendAuthMessage,
	sendCreatePasswordMessage,
} from '$lib/stores/websocket-store.svelte';
import { cn } from '$lib/utils.js';

const MIN_PASSWORD_LENGTH = 8;

let password: string = $state('');
let confirmPassword: string = $state('');
let remember: boolean = $state(false);
let showPassword: boolean = $state(false);

let isLoading = $state(false);
let setPassword: boolean = $state(false);

// The password value that produced the most recent auth rejection. While the
// field still holds it, the inline "incorrect password" error stays visible;
// the moment the operator edits the field it clears. No toast, no live device data.
let rejectedPassword: string | null = $state(null);

// ── Inline validation (errors only — no per-keystroke affirmations) ──
const passwordTooShort = $derived(
	setPassword && password.length > 0 && password.length < MIN_PASSWORD_LENGTH,
);
const confirmMismatch = $derived(
	setPassword && confirmPassword.length > 0 && confirmPassword !== password,
);
const loginRejected = $derived(
	!setPassword && rejectedPassword !== null && password === rejectedPassword,
);

const passwordError = $derived.by(() => {
	if (passwordTooShort) return $LL.auth.passwordTooShort();
	if (loginRejected) return $LL.auth.wrongPassword();
	return '';
});
const confirmError = $derived(confirmMismatch ? $LL.auth.passwordsDoNotMatch() : '');

const isFormValid = $derived(
	setPassword
		? password.length >= MIN_PASSWORD_LENGTH && confirmPassword === password
		: password.length >= 1,
);

// Surfaces when the auth token expired mid-session (Task 16). We arrive here
// without blanking the UI — the operator simply re-authenticates.
const sessionExpired = $derived(getSessionExpired());

// Slim pre-auth connection strip: WS reachability only, zero device telemetry.
// Bound to the live socket connection state (offline-state tracks the rpcClient
// socket open/close/error); subscriptions.svelte's getters are never initialised.
const connection = $derived.by(() => {
	const state = getConnectionState();
	if (state === 'connected') {
		return { tone: 'bg-status-success', label: 'Device connected' };
	}
	if (state === 'connecting') {
		return { tone: 'bg-status-warning animate-pulse', label: 'Connecting…' };
	}
	return { tone: 'bg-status-error', label: 'Device unreachable' };
});

$effect(() => {
	const status = getStatus();
	if (status) {
		setPassword = status.set_password ?? false;
		if (setPassword) {
			localStorage.removeItem('auth');
		}
	}
});

/**
 * Remember-me persists the password in localStorage for auto-login on reload.
 * Intentional for this embedded encoder UI on trusted local networks; plaintext
 * storage is a deliberate tradeoff for simple device UX—avoid on shared or hostile networks.
 */
$effect(() => {
	const message = getAuth();
	if (message?.success === true && remember && password) {
		localStorage.setItem('auth', password);
	}
	if (message?.success === false) {
		isLoading = false;
		// Wrong password surfaces here (rpc.auth.login → success:false), not via a toast.
		rejectedPassword = password;
	}
});

$effect(() => {
	const messages = getNotifications();
	if (
		messages?.show?.find((message) => {
			return message.name === 'auth';
		})
	) {
		isLoading = false;
		localStorage.removeItem('auth');
		// Surface the failure inline beneath the field instead of a toast.
		rejectedPassword = password;
	}
});

function login(password: string, remember: boolean) {
	isLoading = true;
	if (setPassword) {
		sendCreatePasswordMessage(password);
	}
	setPassword = false;
	sendAuthMessage(password, remember, () => (isLoading = false));
}

async function onSubmit(event: SubmitEvent) {
	event.preventDefault();
	if (!isFormValid || isLoading) return;
	login(password, remember);
}
</script>

<div class="bg-background relative grid min-h-dvh place-items-center overflow-hidden px-4 py-12">
	<!-- Instrument ambiance: a single faint phosphor glow, not glassmorphism -->
	<div aria-hidden="true" class="pointer-events-none absolute inset-0">
		<div
			class="absolute start-1/2 top-[38%] size-[34rem] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.06] blur-3xl rtl:translate-x-1/2"
			style="background: var(--primary)"
		></div>
	</div>

	<!-- Slim connection strip: WS reachability only (no telemetry pre-auth) -->
	<div
		data-connection-strip
		role="status"
		class="bg-card/85 text-muted-foreground absolute start-4 top-4 z-10 flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium backdrop-blur-sm md:start-6 md:top-6"
	>
		<span class={cn('inline-block size-2 shrink-0 rounded-full', connection.tone)}></span>
		<span class="tabular-nums">{connection.label}</span>
	</div>

	<!-- Locale + theme controls -->
	<div class="absolute end-4 top-4 z-10 flex items-center gap-1 md:end-6 md:top-6">
		<LocaleSelector />
		<ModeToggle />
	</div>

	<!-- Auth card -->
	<div
		class="bg-card relative z-10 w-full max-w-sm rounded-xl border p-6 shadow-lg duration-300 ease-out sm:p-8 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95"
	>
		<!-- Brand mark -->
		<div class="flex flex-col items-center gap-3 text-center">
			<svg
				viewBox="0 0 24 24"
				class="text-primary size-9"
				aria-hidden="true"
				fill="none"
			>
				<path
					d="M12 2 21 7v10l-9 5-9-5V7z"
					stroke="currentColor"
					stroke-width="1.75"
					stroke-linejoin="round"
				/>
				<circle cx="12" cy="12" r="2.75" fill="currentColor" />
			</svg>
			<div class="space-y-1">
				<p class="text-foreground text-xl font-semibold tracking-tight">{deviceName}</p>
				<p class="text-muted-foreground text-sm text-balance">
					{setPassword
						? $LL.auth.help.createPasswordDescription()
						: $LL.auth.usePassword()}
				</p>
			</div>
		</div>

		{#if sessionExpired && !setPassword}
			<div
				class="bg-status-warning/10 border-status-warning/30 text-foreground mt-6 flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm"
				role="status"
			>
				<AlertCircle class="text-status-warning size-4 shrink-0" />
				<span>{$LL.connection.sessionExpired()}</span>
			</div>
		{/if}

		<form class="mt-8 space-y-5" onsubmit={onSubmit}>
			<!-- Password field -->
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="password">
					{setPassword ? $LL.auth.newPassword() : $LL.auth.password()}
				</Label>

				<div class="relative">
					<Input
						id="password"
						aria-describedby={passwordError ? 'password-error' : undefined}
						aria-invalid={Boolean(passwordError)}
						class={cn(
							'h-11 w-full pe-12',
							passwordError && 'border-destructive focus-visible:border-destructive',
						)}
						autocapitalize="none"
						autocomplete={setPassword ? 'new-password' : 'current-password'}
						autocorrect="off"
						dir="ltr"
						disabled={isLoading}
						placeholder={setPassword
							? $LL.auth.placeholderNewPassword()
							: $LL.auth.placeholderPassword()}
						type={showPassword ? 'text' : 'password'}
						bind:value={password}
					/>

					<Button
						class="absolute end-1 top-1/2 size-9 -translate-y-1/2 text-muted-foreground"
						aria-label={showPassword ? $LL.auth.hidePassword() : $LL.auth.showPassword()}
						aria-pressed={showPassword}
						onclick={() => (showPassword = !showPassword)}
						type="button"
						variant="ghost"
						size="icon-sm"
					>
						{#if showPassword}
							<EyeOff class="size-4" />
						{:else}
							<Eye class="size-4" />
						{/if}
					</Button>
				</div>

				{#if passwordError}
					<p
						id="password-error"
						class="text-destructive flex items-center gap-1.5 text-sm"
					>
						<AlertCircle class="size-3.5 shrink-0" />
						{passwordError}
					</p>
				{/if}
			</div>

			<!-- Confirm password (first-time setup only) -->
			{#if setPassword}
				<div class="space-y-2">
					<Label class="text-sm font-medium" for="confirm-password">
						{$LL.auth.confirmPassword()}
					</Label>
					<Input
						id="confirm-password"
						aria-describedby={confirmError ? 'confirm-error' : undefined}
						aria-invalid={Boolean(confirmError)}
						class={cn(
							'h-11 w-full',
							confirmError && 'border-destructive focus-visible:border-destructive',
						)}
						autocapitalize="none"
						autocomplete="new-password"
						autocorrect="off"
						dir="ltr"
						disabled={isLoading}
						placeholder={$LL.auth.placeholderConfirmPassword()}
						type={showPassword ? 'text' : 'password'}
						bind:value={confirmPassword}
					/>
					{#if confirmError}
						<p
							id="confirm-error"
							class="text-destructive flex items-center gap-1.5 text-sm"
						>
							<AlertCircle class="size-3.5 shrink-0" />
							{confirmError}
						</p>
					{/if}
				</div>
			{/if}

			<!-- Remember me (44px tap row) -->
			{#if !setPassword}
				<Label
					class="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium select-none"
					for="remember"
				>
					<Checkbox id="remember" class="size-5" bind:checked={remember} />
					{$LL.auth.rememberMe()}
				</Label>
			{/if}

			<!-- Submit -->
			<Button
				class="h-11 w-full text-sm font-semibold"
				disabled={isLoading || !isFormValid}
				type="submit"
			>
				{#if isLoading}
					<LoaderCircle class="size-4 animate-spin" />
					{setPassword ? $LL.auth.creatingPassword() : $LL.auth.signingIn()}
				{:else}
					{setPassword ? $LL.auth.setPassword() : $LL.auth.unlock()}
				{/if}
			</Button>
		</form>

		<!-- Footer -->
		<p class="text-muted-foreground mt-6 text-center text-xs">
			{$LL.auth.secureAccess()} · {siteName}
		</p>
	</div>
</div>
