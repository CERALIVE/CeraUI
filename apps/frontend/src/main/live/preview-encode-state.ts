/**
 * Pure, rune-free derivation behind `PreviewEncodeControl.svelte`.
 *
 * The hardware-preview control pairs THREE independent facts that arrive on
 * three different channels, and the whole value of the control is that it never
 * conflates them:
 *
 *  - CAPABILITY — `capabilities.preview.preview_hw_capability`. A PLATFORM fact
 *    the engine stamps from its HAL descriptor, published on the idle-safe
 *    `get-capabilities` channel. It is the SOLE visibility gate.
 *  - REQUEST — `config.previewEncode`. CeraUI's own persisted operator choice.
 *    There is no requested-mode fact anywhere on the engine wire; the engine
 *    only ever reports what it REALIZED.
 *  - REALIZED — `status.preview_encoder_realized`. Session-scoped engine truth
 *    about the live preview branch, absent whenever no session is running.
 *
 * Sibling of `lib/components/preview/preview-availability.ts`, which does the
 * same job for the preview canvas's band set: the component stays a renderer and
 * every decision is testable without a DOM.
 */
import { isPreviewHardwareEncodeCapable } from "@ceraui/rpc";
import type {
	CapabilitiesMessage,
	ConfigMessage,
	PreviewEncodeFallback,
	PreviewEncodeMode,
	PreviewEncoderRealized,
} from "@ceraui/rpc/schemas";

/** What the live preview branch is actually encoding with, when there is one. */
export interface PreviewEncodeActive {
	/** The element in the graph — `mpph264enc`, `x264enc`, … */
	readonly element: string;
	/** The ACTIVE mode. Never the request. */
	readonly mode: PreviewEncodeMode;
}

export interface PreviewEncodeView {
	/**
	 * Render the control at all. `true` ONLY when the board explicitly published
	 * the capability. A board that published `false` and a legacy engine that
	 * published nothing are DIFFERENT facts, but both hide the control — offering
	 * a switch the board cannot honour is worse than offering none.
	 */
	readonly visible: boolean;
	/** The persisted operator request. Absent config reads `software`, never `hardware`. */
	readonly requested: PreviewEncodeMode;
	/** The live realization, or `null` when no session is publishing one. */
	readonly active: PreviewEncodeActive | null;
	/** The engine's fallback report, or `null` when nothing fell back. */
	readonly fallback: PreviewEncodeFallback | null;
}

/**
 * Resolve the control's whole render state from the three channels.
 *
 * The fallback leg keys on the engine's own report rather than on a
 * config-vs-status comparison done here. The engine emits `fallback_reason`
 * exactly when hardware was requested and software was realized, so it already
 * IS the requested-vs-realized verdict — and it survives an operator flipping the
 * persisted request back to software mid-session, which a local comparison would
 * silently erase while the fallen-back session is still running.
 */
export function derivePreviewEncodeView(
	caps: CapabilitiesMessage | undefined,
	realized: PreviewEncoderRealized | null | undefined,
	config: ConfigMessage | undefined,
): PreviewEncodeView {
	const active: PreviewEncodeActive | null = realized
		? { element: realized.realized_element, mode: realized.mode }
		: null;
	const reason = realized?.fallback_reason;
	return {
		visible: isPreviewHardwareEncodeCapable(caps),
		requested: config?.previewEncode ?? "software",
		active,
		fallback: reason && realized?.mode === "software" ? reason : null,
	};
}
