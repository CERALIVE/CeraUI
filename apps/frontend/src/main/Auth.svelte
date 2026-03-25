<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { AlertCircle, CheckCircle, Eye, EyeOff, LoaderCircle } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { Checkbox } from '$lib/components/ui/checkbox';
import Logo from '$lib/components/icons/Logo.svelte';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import LocaleSelector from '$lib/components/ui/locale-selector.svelte';
import ModeToggle from '$lib/components/ui/mode-toggle.svelte';
import { siteName } from '$lib/config';
import {
	getAuth,
	getNotifications,
	getStatus,
	sendAuthMessage,
	sendCreatePasswordMessage,
} from '$lib/stores/websocket-store.svelte';
import { cn } from '$lib/utils.js';

let className: string | undefined | null = $state(undefined);
export { className as class };

let password: string = $state('');
let remember: boolean = $state(false);
let showPassword: boolean = $state(false);

let isLoading = $state(false);
let setPassword: boolean = $state(false);

const validation = $derived({
	password: {
		isValid: password.length >= (setPassword ? 8 : 1),
		isEmpty: password.length === 0,
		message:
			setPassword && password.length < 8 && password.length > 0
				? $LL?.auth?.validation?.passwordMinLength?.() || 'Password must be at least 8 characters'
				: '',
	},
});

const isFormValid = $derived(validation.password.isValid);

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
	login(password, remember);
}
</script>

<div
	class="relative grid h-dvh flex-col items-center justify-center lg:max-w-none lg:grid-cols-2 lg:px-0"
>
	<!-- Controls -->
	<div class="absolute top-4 right-4 z-10 flex items-center gap-1 md:top-6 md:right-6">
		<LocaleSelector />
		<ModeToggle />
	</div>

	<!-- Left panel: brand -->
	<div class="bg-primary/5 relative hidden h-full flex-col items-center justify-center p-10 lg:flex dark:bg-primary/[0.03]">
		<div class="flex flex-col items-center gap-6">
			<Logo aria-hidden={true} class="h-16 w-16" />
			<div class="text-center">
				<p class="text-foreground text-xl font-semibold tracking-tight">{siteName}</p>
				<p class="text-muted-foreground mt-2 max-w-xs text-sm leading-relaxed">
					Professional streaming encoder management
				</p>
			</div>
		</div>
	</div>

	<!-- Right panel: form -->
	<div class="flex items-center justify-center px-4 lg:p-8">
		<div class="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[360px]">
			<!-- Header -->
			<div class="flex flex-col space-y-2 text-center lg:text-left">
				<div class="mb-1 lg:hidden">
					<Logo aria-hidden={true} class="mx-auto h-10 w-10 lg:mx-0" />
				</div>
				<h1 class="text-2xl font-bold tracking-tight">
					{setPassword
						? $LL?.auth?.createPasswordAndLogin?.() || 'Create Password & Login'
						: $LL?.auth?.loginWithPassword?.() || 'Login with Password'}
				</h1>
				<p class="text-muted-foreground text-sm">
					{$LL?.auth?.usePassword?.() || 'Use your password to access the device'}
				</p>
			</div>

			<div class={cn('grid gap-5', className)}>
				<form onsubmit={onSubmit}>
					<div class="grid gap-4">
						<!-- Password field -->
						<div class="space-y-2">
							<Label class="text-sm font-medium" for="password">
								{setPassword
									? $LL?.auth?.newPassword?.() || 'New Password'
									: $LL?.auth?.password?.() || 'Password'}
							</Label>

							<div class="relative">
								<Input
									id="password"
									aria-describedby={validation.password.message ? 'password-error' : undefined}
									aria-invalid={!validation.password.isValid && !validation.password.isEmpty}
									class={cn(
										'h-11 w-full pr-20 transition-colors',
										!validation.password.isValid && !validation.password.isEmpty
											? 'border-destructive focus:border-destructive'
											: validation.password.isValid && !validation.password.isEmpty
												? 'border-status-success focus:border-status-success'
												: '',
									)}
									autocapitalize="none"
									autocomplete={setPassword ? 'new-password' : 'current-password'}
									autocorrect="off"
									disabled={isLoading}
									placeholder={setPassword
										? $LL?.auth?.placeholderNewPassword?.() || 'Enter new password'
										: $LL?.auth?.placeholderPassword?.() || 'Enter password'}
									type={showPassword ? 'text' : 'password'}
									bind:value={password}
								/>

								<div class="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5">
									{#if !validation.password.isEmpty}
										{#if validation.password.isValid}
											<CheckCircle class="text-status-success h-4 w-4" />
										{:else}
											<AlertCircle class="text-destructive h-4 w-4" />
										{/if}
									{/if}
									<Button
										class="h-11 w-11"
										aria-label="Toggle password visibility"
										onclick={() => (showPassword = !showPassword)}
										type="button"
										variant="ghost"
										size="icon-sm"
									>
										{#if showPassword}
											<EyeOff class="text-muted-foreground h-4 w-4" />
										{:else}
											<Eye class="text-muted-foreground h-4 w-4" />
										{/if}
									</Button>
								</div>
							</div>

							{#if validation.password.message}
								<p
									id="password-error"
									class="text-destructive flex items-center gap-1.5 text-sm"
								>
									<AlertCircle class="h-3.5 w-3.5" />
									{validation.password.message}
								</p>
							{:else if setPassword && validation.password.isValid}
								<p class="text-status-success flex items-center gap-1.5 text-sm">
									<CheckCircle class="h-3.5 w-3.5" />
									{$LL?.auth?.validation?.passwordValid?.() || 'Password is valid'}
								</p>
							{/if}
						</div>

						<!-- Submit -->
						<Button
							class="h-11 w-full font-medium"
							disabled={isLoading || !isFormValid}
							type="submit"
						>
							{#if isLoading}
								<LoaderCircle class="mr-2 h-4 w-4 animate-spin" />
								{setPassword
									? $LL?.auth?.creatingPassword?.() || 'Creating Password'
									: $LL?.auth?.signingIn?.() || 'Signing In'}
							{:else}
								{setPassword
									? $LL?.auth?.createPassword?.() || 'Create Password'
									: $LL?.auth?.signIn?.() || 'Sign In'}
							{/if}
						</Button>
					</div>

					<!-- Remember me -->
					<div class="mt-4 flex items-center gap-2.5">
						<Checkbox id="remember" bind:checked={remember} />
						<Label
							class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
							for="remember"
						>
							{$LL?.auth?.rememberMe?.() || 'Remember me'}
						</Label>
					</div>
				</form>

				{#if setPassword}
					<div class="bg-accent rounded-lg p-4">
						<div class="flex items-start gap-3">
							<AlertCircle class="text-accent-foreground mt-0.5 h-4 w-4 flex-shrink-0" />
							<div class="space-y-1">
								<p class="text-accent-foreground text-sm font-medium">
									{$LL?.auth?.help?.createPasswordTitle?.() || 'Create your password'}
								</p>
								<p class="text-muted-foreground text-xs leading-relaxed">
									{$LL?.auth?.help?.createPasswordDescription?.() ||
										'Create a secure password to protect your device access'}
								</p>
							</div>
						</div>
					</div>
				{/if}
			</div>

			<!-- Footer -->
			<p class="text-muted-foreground text-center text-xs">
				{$LL?.auth?.footerText?.() || 'Secure device access'} &middot; {siteName}
			</p>
		</div>
	</div>
</div>
