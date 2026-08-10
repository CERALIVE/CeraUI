/**
 * Preview capability selectors — pure, browser-safe derivations from the
 * capabilities contract.
 */

import type { CapabilitiesMessage } from '../schemas/streaming.schema';

/**
 * Whether this BOARD publishes a hardware preview encoder.
 *
 * Returns `true` only when the engine explicitly advertises the capability
 * (`preview.preview_hw_capability === true`) — the sole gate for any
 * hardware-preview control. `false` (the board publishes none) and absent (a
 * pre-2026.7.6 engine that never stated a capability) both hide the control, but
 * they are DIFFERENT facts and must not be normalized into one another anywhere
 * upstream of this gate: a stored `false` would wrongly outlive an engine
 * upgrade that makes the board capable.
 *
 * This reads the PLATFORM channel, which is populated while idle. It says
 * nothing about what a live session realized — that is
 * `status.preview_encoder_realized`.
 */
export function isPreviewHardwareEncodeCapable(caps: CapabilitiesMessage | undefined): boolean {
	return caps?.preview?.preview_hw_capability === true;
}
