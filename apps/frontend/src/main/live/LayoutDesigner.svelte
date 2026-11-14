<!--
  LayoutDesigner — places the second picture input on the preview.

  An overlay over the preview picture: the inset (`layout-inset`) is where the
  compositor puts the second input, drawn over the letterboxed picture area
  (`videoBox`). It drags with pointer capture, resizes from four corner handles,
  and moves with the arrow keys (1%, Shift 5%; Alt resizes). It moves locally
  while dragging and sends ONE placement on release: `composition_rect`, already
  clamped, which the device composes onto the composition it has saved (live,
  with `apply_now: true`). The client never sends its own copy of the other
  composition fields, so a stale tab or a quick second drag cannot overwrite a
  newer change. One placement is in flight at a time; a newer release waits for
  its answer and replaces any older waiting one. A refused placement falls back
  to the device's saved rectangle and says why.

  The rectangle is in frame coordinates, which do not mirror right-to-left, so
  positions are physical left/top.

  VISIBILITY IS THE PARENT'S: mounted only while composition is on, the engine
  advertises `composition-geometry` and the preview is open.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type {
	CompositionConfig,
	CompositionRect,
	StreamingSetConfigInput,
	StreamingSetConfigOutput,
} from '@ceraui/rpc/schemas';

import { rpc } from '$lib/rpc';
import { configChangeReport } from '$lib/streaming/configChangeCopy';
import {
	CORNERS,
	type Corner,
	moveRect,
	presetRect,
	resizeRect,
	sameRect,
	videoBox,
} from '$lib/streaming/layoutRect';

interface Props {
	/** The composition the device has saved. */
	composition: CompositionConfig;
	isStreaming: boolean;
	/** The picture's own size, 0 while unknown. */
	pictureWidth?: number;
	pictureHeight?: number;
}

const { composition, isStreaming, pictureWidth = 0, pictureHeight = 0 }: Props = $props();

const STEP = 0.01;
const FAST_STEP = 0.05;
const ARROWS: Record<string, readonly [number, number]> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
};
const REFUSAL_TOKENS = new Set([
	'composition_unsupported',
	'composition_geometry_unsupported',
	'composition_rect_invalid',
]);
const descriptionId = $props.id();

const saved = $derived(
	composition.layout === 'custom'
		? (composition.rect ?? presetRect('pip-top-right'))
		: presetRect(composition.layout),
);

// The local rectangle while a drag or held key moves it; the newest released
// placement still waiting to be sent; the one the device has not answered yet.
let draft = $state<CompositionRect | undefined>(undefined);
let queued = $state<CompositionRect | undefined>(undefined);
let inFlight = $state<CompositionRect | undefined>(undefined);
let refusal = $state<string | undefined>(undefined);

const shown = $derived(draft ?? queued ?? inFlight ?? saved);

let stageWidth = $state(0);
let stageHeight = $state(0);
const box = $derived(videoBox(stageWidth, stageHeight, pictureWidth, pictureHeight));

type Drag = { pointerId: number; corner: Corner | undefined; x: number; y: number; from: CompositionRect };
let drag = $state<Drag | undefined>(undefined);
let heldKeys: string[] = [];

const percent = (value: number) => Math.round(value * 100);
// While a pointer drags, the description keeps the starting position so a
// screen reader is not flooded with a value per frame.
const described = $derived(drag?.from ?? shown);
const position = $derived(
	m['live.layout.insetPosition']({
		x: percent(described.x),
		y: percent(described.y),
		width: percent(described.width),
		height: percent(described.height),
	}),
);

function refusalOf(result: StreamingSetConfigOutput): string | undefined {
	const change = result.configChange;
	if (change !== undefined && change.result !== 'applied') return configChangeReport(change, m).message;
	if (result.success) return undefined;
	return result.error !== undefined && REFUSAL_TOKENS.has(result.error)
		? resolveMessageKey(`live.layout.error.${result.error}`)
		: m['notifications.saveFailed']();
}

async function send(): Promise<void> {
	if (inFlight !== undefined || queued === undefined) return;
	const rect = queued;
	queued = undefined;
	inFlight = rect;
	refusal = undefined;
	const input: StreamingSetConfigInput = isStreaming
		? { composition_rect: rect, apply_now: true }
		: { composition_rect: rect };
	try {
		refusal = refusalOf(await rpc.streaming.setConfig(input));
	} catch {
		refusal = m['notifications.saveFailed']();
	} finally {
		inFlight = undefined;
		void send();
	}
}

function commit(): void {
	const placed = draft;
	draft = undefined;
	if (placed === undefined || sameRect(placed, shown)) return;
	queued = placed;
	void send();
}

function startDrag(event: PointerEvent & { currentTarget: HTMLElement }): void {
	if (event.button !== 0 || drag !== undefined) return;
	const handle = (event.target as Element).closest<HTMLElement>('[data-corner]');
	drag = {
		pointerId: event.pointerId,
		corner: handle?.dataset.corner as Corner | undefined,
		x: event.clientX,
		y: event.clientY,
		from: shown,
	};
	heldKeys = [];
	event.currentTarget.setPointerCapture(event.pointerId);
	event.currentTarget.focus();
	event.preventDefault();
}

function moveDrag(event: PointerEvent): void {
	if (drag === undefined || event.pointerId !== drag.pointerId || box.width === 0) return;
	const dx = (event.clientX - drag.x) / box.width;
	const dy = (event.clientY - drag.y) / box.height;
	draft =
		drag.corner === undefined
			? moveRect(drag.from, dx, dy)
			: resizeRect(drag.from, drag.corner, dx, dy);
}

function endDrag(event: PointerEvent): void {
	if (drag === undefined || event.pointerId !== drag.pointerId) return;
	drag = undefined;
	commit();
}

function cancelDrag(event: PointerEvent): void {
	if (drag === undefined || event.pointerId !== drag.pointerId) return;
	drag = undefined;
	draft = undefined;
}

// A keyup can report a different key than its keydown (Shift turns Numpad4's
// ArrowLeft into "4"), so held keys are tracked by the physical key.
const physicalKey = (event: KeyboardEvent) => event.code || event.key;

function keyDown(event: KeyboardEvent): void {
	if (drag !== undefined) return;
	if (event.key === 'Escape' && draft !== undefined) {
		heldKeys = [];
		draft = undefined;
		event.preventDefault();
		return;
	}
	const direction = ARROWS[event.key];
	if (direction === undefined) return;
	event.preventDefault();
	const step = event.shiftKey ? FAST_STEP : STEP;
	const [dx, dy] = [direction[0] * step, direction[1] * step];
	const from = draft ?? shown;
	draft = event.altKey ? resizeRect(from, 'bottom-right', dx, dy) : moveRect(from, dx, dy);
	const key = physicalKey(event);
	if (!heldKeys.includes(key)) heldKeys = [...heldKeys, key];
}

function keyUp(event: KeyboardEvent): void {
	const key = physicalKey(event);
	if (!heldKeys.includes(key)) return;
	heldKeys = heldKeys.filter((held) => held !== key);
	if (heldKeys.length === 0) commit();
}

function blur(): void {
	if (drag !== undefined) return;
	heldKeys = [];
	commit();
}

const percentStyle = (value: number) => `${(value * 100).toFixed(2)}%`;
</script>

<div
	bind:clientHeight={stageHeight}
	bind:clientWidth={stageWidth}
	class="pointer-events-none absolute inset-0"
>
	<div
		class="absolute"
		style:height="{box.height}px"
		style:left="{box.x}px"
		style:top="{box.y}px"
		style:width="{box.width}px"
	>
		<button
			aria-describedby={descriptionId}
			aria-label={m['live.layout.inset']()}
			class="border-primary bg-primary/15 data-[dragging=true]:bg-primary/25 focus-visible:ring-ring/50 pointer-events-auto absolute cursor-move touch-none rounded-sm border-2 outline-none select-none focus-visible:ring-3"
			data-dragging={drag !== undefined}
			data-testid="layout-inset"
			onblur={blur}
			onkeydown={keyDown}
			onkeyup={keyUp}
			onlostpointercapture={cancelDrag}
			onpointercancel={cancelDrag}
			onpointerdown={startDrag}
			onpointermove={moveDrag}
			onpointerup={endDrag}
			style:height={percentStyle(shown.height)}
			style:left={percentStyle(shown.x)}
			style:top={percentStyle(shown.y)}
			style:width={percentStyle(shown.width)}
			type="button"
		>
			{#each CORNERS as corner (corner)}
				<span
					aria-hidden="true"
					class="absolute grid size-11 -translate-x-1/2 -translate-y-1/2 touch-none place-items-center {corner ===
						'top-left' || corner === 'bottom-right'
						? 'cursor-nwse-resize'
						: 'cursor-nesw-resize'}"
					data-corner={corner}
					data-testid={`layout-inset-handle-${corner}`}
					style:left={corner.endsWith('left') ? '0%' : '100%'}
					style:top={corner.startsWith('top') ? '0%' : '100%'}
				>
					<span class="border-background bg-primary size-3 rounded-full border-2"></span>
				</span>
			{/each}
		</button>
	</div>

	<span aria-live="polite" class="sr-only" id={descriptionId}>
		{position}
		{m['live.layout.insetKeys']()}
	</span>

	<!-- Mounted for the whole session so a refusal is announced the moment it lands. -->
	<div aria-live="assertive" class="absolute inset-x-2 top-2 flex justify-center" role="alert">
		{#if refusal !== undefined}
			<p
				class="bg-background/90 border-status-warning/50 text-foreground max-w-full rounded-md border px-3 py-1.5 text-xs"
			>
				{refusal}
			</p>
		{/if}
	</div>
</div>
