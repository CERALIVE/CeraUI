<script lang="ts">
// Optimistic boot shell (Task 16). Rendered immediately so the operator never
// faces a blank screen, then dismissed by App.svelte the instant the device
// speaks (getConnectionReady()). Purely presentational — no timers, no fetches.
// Copy is a literal, not i18n: this paints before the locale bundle loads.
</script>

<div
	aria-busy="true"
	aria-live="polite"
	class="boot-shell bg-background text-foreground fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 px-6"
	data-boot-shell
	role="status"
>
	<div class="boot-dial" aria-hidden="true">
		<span class="boot-ring"></span>
		<span class="boot-core bg-primary"></span>
	</div>

	<div class="flex flex-col items-center gap-1.5 text-center">
		<p class="text-foreground font-mono text-base font-medium tracking-tight">Connecting to device…</p>
		<p class="text-muted-foreground text-sm">Establishing the live link</p>
	</div>
</div>

<style>
	.boot-dial {
		position: relative;
		display: grid;
		place-items: center;
		width: 4rem;
		height: 4rem;
	}

	.boot-ring {
		position: absolute;
		inset: 0;
		border-radius: 9999px;
		border: 2px solid color-mix(in oklch, var(--primary) 22%, transparent);
		border-top-color: var(--primary);
		animation: boot-spin 0.9s cubic-bezier(0.22, 1, 0.36, 1) infinite;
	}

	.boot-core {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 9999px;
		box-shadow: 0 0 12px 1px color-mix(in oklch, var(--primary) 60%, transparent);
		animation: boot-pulse 1.8s ease-in-out infinite;
	}

	@keyframes boot-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes boot-pulse {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.55;
			transform: scale(0.78);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.boot-ring {
			animation: boot-fade 1.6s ease-in-out infinite;
			border-top-color: color-mix(in oklch, var(--primary) 22%, transparent);
		}
		.boot-core {
			animation: boot-fade 1.6s ease-in-out infinite;
		}
	}

	@keyframes boot-fade {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.5;
		}
	}
</style>
