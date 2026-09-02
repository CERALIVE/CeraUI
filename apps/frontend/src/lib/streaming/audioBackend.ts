/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The operator-facing reading of the engine's audio-backend capability — the UI
 * half of `apps/backend/src/modules/streaming/audio-backend.ts`.
 *
 * Pure and rune-free: the Audio dialog only layers state on it, so every offer,
 * refusal and resting value below is assertable without mounting anything.
 *
 * FOUR rules carry it, and each one is a defect this module exists to prevent:
 *
 * 1. **A backend the capability payload does not list is NEVER offered.** The
 *    option list is `capability.supported` and nothing else — not the enum, not
 *    the persisted selection, not the pair. An engine build with no PipeWire arm
 *    must not be able to have `pipewire` written against it, because the device
 *    refuses that write (`audio_backend_unsupported`) and, worse, a stored value
 *    the engine cannot honour becomes a start failure with no UI route back.
 * 2. **ABSENT IS NOT `alsa`.** `config.audio_backend` is absent on every device
 *    in the fleet and means "the operator stated nothing", which hands the
 *    ENGINE'S OWN default (shipped: pipewire) the decision. The resting value is
 *    therefore the engine's own `active`, never the first enum member — a
 *    selector that pre-selects `alsa` would misreport every unconfigured board.
 * 3. **An absent capability block renders ZERO nodes.** The engine never stated
 *    a capability (a legacy build, or a fallback snapshot), so there is no
 *    capability being withheld to explain — a disabled control there would imply
 *    one. This is the same CT-1 rule the modem capability dialog follows, and it
 *    is what keeps an older engine byte-identical to today.
 * 4. **ONE supported backend is a STATE, not a choice.** It renders — the
 *    operator still needs to know which arm this build runs — but disabled, with
 *    a reason. Offering a radiogroup of one is a control that cannot act.
 *
 * The backend NAMES are not translated copy. `ALSA` and `PipeWire` are the
 * subsystems' own proper nouns and read identically in every locale, exactly
 * like the device strings the modem identity line renders verbatim.
 */

import type { MessageFn, MessageKey } from "@ceraui/i18n/svelte";
import type { AudioBackend, CapabilitiesMessage } from "@ceraui/rpc/schemas";

/** The subset of the i18n facade these pure helpers need: keyed lookup only. */
type Messages = Readonly<Record<MessageKey, MessageFn>>;

/**
 * The engine capability block, exactly as `capabilitiesMessageSchema` carries
 * it. Absent on every fallback rung — see rule 3.
 */
export type AudioBackendCapability = NonNullable<
	CapabilitiesMessage["audio_backends"]
>;

/**
 * The device's typed `setConfig` refusal for a backend the engine has not
 * advertised. Mirrors `AUDIO_BACKEND_UNSUPPORTED_ERROR` in
 * `apps/backend/src/modules/streaming/audio-backend.ts`; it is the wire token,
 * so it is a string literal on both sides rather than a shared import (this
 * package is browser-only and carries no backend dependency).
 */
export const AUDIO_BACKEND_UNSUPPORTED_ERROR = "audio_backend_unsupported";

/** Subsystem proper nouns — deliberately NOT i18n copy (see the header). */
export const AUDIO_BACKEND_LABELS = {
	alsa: "ALSA",
	pipewire: "PipeWire",
} as const satisfies Record<AudioBackend, string>;

export function audioBackendLabel(backend: AudioBackend): string {
	return AUDIO_BACKEND_LABELS[backend];
}

/**
 * `absent`   — the engine stated no capability. Render nothing at all.
 * `single`   — exactly one supported backend. Render it, disabled, with a reason.
 * `offered`  — two or more. Render the radiogroup.
 */
export type AudioBackendOfferMode = "absent" | "single" | "offered";

export interface AudioBackendOption {
	readonly backend: AudioBackend;
	readonly label: string;
	/** The backend that takes effect at the next start. */
	readonly selected: boolean;
	/** The backend the engine is running RIGHT NOW. */
	readonly active: boolean;
}

export interface AudioBackendView {
	readonly mode: AudioBackendOfferMode;
	/** Exactly `capability.supported`, in payload order. Never wider. */
	readonly options: readonly AudioBackendOption[];
	/** What the engine is running now (`capability.active`). */
	readonly active: AudioBackend | undefined;
	/** What takes effect at the next start: the stated pick, else `active`. */
	readonly selected: AudioBackend | undefined;
	/** The operator stated this selection (vs inheriting the engine default). */
	readonly stated: boolean;
	/**
	 * A STORED selection this engine build no longer advertises. It is reported
	 * rather than offered: the option list stays supported-only (rule 1) while
	 * the truth about what is on disk is still stated on screen.
	 */
	readonly staleSelection: AudioBackend | undefined;
	/** Why nothing is selectable — `single` only, `undefined` otherwise. */
	readonly disabledReasonKey: MessageKey | undefined;
	/** The pick differs from the running arm, so it is a next-start change. */
	readonly appliesNextStart: boolean;
}

const NO_VIEW: AudioBackendView = {
	mode: "absent",
	options: [],
	active: undefined,
	selected: undefined,
	stated: false,
	staleSelection: undefined,
	disabledReasonKey: undefined,
	appliesNextStart: false,
};

export interface AudioBackendViewInput {
	/** `capabilities.audio_backends`, forwarded verbatim from the engine. */
	readonly capability: AudioBackendCapability | undefined;
	/** `config.audio_backend` — ABSENT means the operator stated nothing. */
	readonly selection: AudioBackend | undefined;
}

export function deriveAudioBackendView(
	input: AudioBackendViewInput,
): AudioBackendView {
	const { capability, selection } = input;
	const supported = capability?.supported ?? [];
	// Rule 3, plus the contradictory-payload case: a block advertising no
	// supported backend states no capability either, so it offers nothing.
	if (capability === undefined || supported.length === 0) return NO_VIEW;

	const active = capability.active;
	// Rule 1: a stored pick outside the advertised set is reported, not offered.
	const stale =
		selection !== undefined && !supported.includes(selection)
			? selection
			: undefined;
	// Rule 2: absent falls back to the ENGINE's own running arm, never `alsa`.
	const selected = stale === undefined ? (selection ?? active) : active;
	const single = supported.length === 1;

	return {
		mode: single ? "single" : "offered",
		options: supported.map((backend) => ({
			backend,
			label: audioBackendLabel(backend),
			selected: backend === selected,
			active: backend === active,
		})),
		active,
		selected,
		stated: selection !== undefined,
		staleSelection: stale,
		disabledReasonKey: single
			? "settings.audioBackend.singleReason"
			: undefined,
		appliesNextStart: selected !== active,
	};
}

/**
 * Whether a backend may be DISPATCHED. The mirror of the device's own
 * `isAudioBackendSupported`, narrowed by the same view the operator is looking
 * at, so a click can never spend a round-trip to be refused for something the
 * offering already knew.
 */
export function canSelectAudioBackend(
	view: AudioBackendView,
	backend: AudioBackend,
): boolean {
	if (view.mode !== "offered") return false;
	if (backend === view.selected) return false;
	return view.options.some((option) => option.backend === backend);
}

/**
 * Operator copy for a REFUSED audio-backend write — the `encoderSaveError`
 * shape, for the same reason it exists: `streaming.setConfig` RESOLVES with
 * `{success:false, error}` rather than throwing, so a caller that only wraps the
 * await in try/catch reports a refusal as success.
 *
 * The typed refusal gets copy naming the actual cause. It should be unreachable
 * from the dialog — `canSelectAudioBackend` mirrors the device's own gate — but
 * it stays reachable by a direct RPC call and by a genuine race, since the
 * engine's advertised set can shrink between the render and the write. Per the
 * repo's operator-copy rule no branch here can surface an engine string, a unit
 * name or a shell command.
 */
export function audioBackendSaveErrorMessage(
	error: string | undefined,
	msg: Messages,
): string {
	if (error === AUDIO_BACKEND_UNSUPPORTED_ERROR) {
		return msg["settings.audioBackend.errorUnsupported"]();
	}
	return msg["notifications.saveFailed"]();
}
