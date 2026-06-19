<script lang="ts">
import { gsap } from 'gsap';

import type { LinkSignal } from '$lib/types/hud';
import { cn } from '$lib/utils';

/**
 * Bond constellation — the HUD's signature "moment" (Task 34).
 *
 * Each SRTLA link is a node fanned on the left; all feed a central bond core on
 * the right, which pulses outbound toward the receiver. When the stream is live
 * (and motion is allowed) packets flow link → core and the core emits outbound
 * pulse rings.
 *
 * Motion is GSAP-driven but transform/opacity ONLY (no width/height/x-attr/cx
 * tweens), so it stays on the compositor and holds 60fps on the Jetson SBC.
 * Three guards keep it honest:
 *   - reduced-motion: `gsap.matchMedia('(prefers-reduced-motion: no-preference)')`
 *     — the timeline is never built when the user asks for less motion.
 *   - e-ink (`frozen`): the matchMedia callback bails before creating tweens, so
 *     no rAF loop runs on an e-paper panel (the app.css `data-display=eink`
 *     freeze only kills CSS animation/transition, NOT GSAP's inline transforms).
 *   - not-live: a parked, static topology renders instead of animating.
 * In every static case the packets sit parked mid-flight via an SVG `transform`
 * attribute (GSAP writes CSS transform, which wins while animating and is
 * cleared on revert — so the parked attribute returns), and `data-animated`
 * reports `"false"` so tests can assert no timeline is running.
 */

interface Props {
	links: LinkSignal[];
	/** Stream is live — drives packet flow + outbound pulse. */
	live?: boolean;
	/** E-ink / mono profile — freeze all motion. */
	frozen?: boolean;
	class?: string;
}

let { links, live = false, frozen = false, class: className }: Props = $props();

// ── Fixed coordinate space (user units). The SVG scales responsively via CSS
//    (width:100%), never by animating geometry. ──────────────────────────────
const VB_W = 220;
const VB_H = 120;
const LINK_X = 32;
const BOND_X = 186;
const BOND_Y = 60;
const PAD_T = 22;
const PAD_B = 98;
const NODE_R = 4;
const PACKET_R = 2.6;
const PULSE_BASE_R = 9;
/** Fraction along the link→core line where a parked (static) packet sits. */
const PARK = 0.62;
const PULSE_COUNT = 2;

interface NodeGeo {
	x: number;
	y: number;
	parkX: number;
	parkY: number;
	color: string;
	connected: boolean;
}

const nodes = $derived<NodeGeo[]>(
	links.map((link, i) => {
		const n = links.length;
		const y = n <= 1 ? BOND_Y : PAD_T + (i * (PAD_B - PAD_T)) / (n - 1);
		const dx = BOND_X - LINK_X;
		const dy = BOND_Y - y;
		return {
			x: LINK_X,
			y,
			parkX: LINK_X + dx * PARK,
			parkY: y + dy * PARK,
			color: `var(--link-${(link.linkIndex % 6) + 1})`,
			connected: link.isConnected,
		};
	}),
);

// Refs populated by bind:this — plain arrays (intentionally NOT $state: GSAP
// owns these nodes' transforms and Svelte must not re-touch them per tick).
let packetEls: (SVGCircleElement | null)[] = [];
let pulseEls: (SVGCircleElement | null)[] = [];

// True only while a GSAP timeline is actually playing. Surfaced as
// data-animated for the static-fallback assertions.
let animated = $state(false);

$effect(() => {
	// Re-evaluate when liveness, freeze, or topology changes.
	const isLive = live;
	const isFrozen = frozen;
	const geo = nodes;

	const mm = gsap.matchMedia();
	mm.add('(prefers-reduced-motion: no-preference)', () => {
		// E-ink frozen or idle → render the static parked topology, no rAF loop.
		if (isFrozen || !isLive || geo.length === 0) return;

		// Packets: link node → bond core. x/y are CSS transforms (translate);
		// opacity keyframes fade each packet in at the source and out at the core.
		geo.forEach((node, i) => {
			const el = packetEls[i];
			if (!el || !node.connected) return;
			gsap.fromTo(
				el,
				{ x: node.x, y: node.y, opacity: 0 },
				{
					keyframes: {
						x: [node.x, BOND_X],
						y: [node.y, BOND_Y],
						opacity: [0, 1, 1, 0],
						easeEach: 'none',
					},
					duration: 1.4,
					ease: 'none',
					repeat: -1,
					repeatDelay: 0.25,
					delay: i * 0.22,
				},
			);
		});

		// Outbound pulse: rings expand + fade from the bond core. transform-box
		// fill-box (CSS) scales around each ring's own centre, not the SVG origin.
		pulseEls.forEach((el, i) => {
			if (!el) return;
			gsap.fromTo(
				el,
				{ scale: 0.4, opacity: 0.55 },
				{
					scale: 3,
					opacity: 0,
					duration: 2.1,
					ease: 'power1.out',
					repeat: -1,
					delay: (i * 2.1) / PULSE_COUNT,
				},
			);
		});

		animated = true;
		return () => {
			animated = false;
		};
	});

	return () => {
		mm.revert();
		animated = false;
	};
});

const activeCount = $derived(links.filter((l) => l.isConnected).length);
</script>

<div
	class={cn('w-full', className)}
	data-testid="bond-constellation"
	data-animated={animated}
	data-live={live}
	data-frozen={frozen}
	data-link-count={links.length}
>
	<svg
		viewBox="0 0 {VB_W} {VB_H}"
		class="h-auto w-full"
		role="img"
		aria-hidden="true"
		preserveAspectRatio="xMidYMid meet"
	>
		<!-- Bond paths (static) -->
		{#each nodes as node, i (i)}
			<line
				x1={node.x}
				y1={node.y}
				x2={BOND_X}
				y2={BOND_Y}
				stroke="var(--border)"
				stroke-width="1"
				stroke-linecap="round"
				opacity={node.connected ? 0.7 : 0.3}
			/>
		{/each}

		<!-- Outbound pulse rings (animated when live; faint static ring otherwise) -->
		{#each Array(PULSE_COUNT) as _, i (i)}
			<circle
				bind:this={pulseEls[i]}
				class="bond-pulse"
				data-testid="bond-pulse"
				cx={BOND_X}
				cy={BOND_Y}
				r={PULSE_BASE_R}
				fill="none"
				stroke="var(--primary)"
				stroke-width="1.25"
				opacity={live && i === 0 ? 0.22 : 0}
			/>
		{/each}

		<!-- Link nodes (static) -->
		{#each nodes as node, i (i)}
			<circle
				data-testid="bond-link-node"
				data-link-index={i}
				cx={node.x}
				cy={node.y}
				r={NODE_R}
				fill={node.color}
				opacity={node.connected ? 1 : 0.4}
			/>
		{/each}

		<!-- Packets (parked static via SVG transform attr; GSAP drives CSS transform) -->
		{#each nodes as node, i (i)}
			<circle
				bind:this={packetEls[i]}
				data-testid="bond-packet"
				cx="0"
				cy="0"
				r={PACKET_R}
				fill={node.color}
				opacity={node.connected ? 0.9 : 0}
				transform="translate({node.parkX} {node.parkY})"
			/>
		{/each}

		<!-- Bond core (static) -->
		<circle cx={BOND_X} cy={BOND_Y} r={PULSE_BASE_R - 1.5} fill="none" stroke="var(--primary)" stroke-width="1" opacity="0.45" />
		<circle data-testid="bond-core" cx={BOND_X} cy={BOND_Y} r="5" fill="var(--primary)" opacity={activeCount > 0 ? 1 : 0.5} />
	</svg>
</div>

<style>
	/* SVG scale tweens orbit each ring's own centre, not the SVG (0,0) origin. */
	.bond-pulse {
		transform-box: fill-box;
		transform-origin: center;
	}
</style>
