/**
 * Pure, rune-free derivations for a capture device's MODE FAMILIES (todo 23).
 *
 * The backend publishes every format a physical camera advertises as
 * `CaptureStreamSource.inputModes[]`, each family carrying its OWN ladder, and
 * names the one the leg will be opened under as `selectedInputMode` (todo 21).
 * This module is the frontend's single reading of that pair — the picker's mode
 * selector and the encoder dialog's ladder BOTH route through it, so what the
 * operator picks and what the dialog then offers can never disagree.
 *
 * The two rules here are deliberately the mirror of the backend's
 * `device-mode-guard.ts` `governingKind()`: the operator's pick governs only
 * while the device still ADVERTISES it, and a per-family ladder is never unioned
 * with another family's (cerastream ADR-0008 §10 — "the UI and the save path may
 * never invent or union"). An offering the save path would refuse is a lie told
 * to the operator; a save the offering would have disabled is a bypass.
 */
import type {
	CaptureInputMode,
	DeviceMode,
	InputMode,
	StreamSource,
} from "@ceraui/rpc/schemas";

/** The i18n key family that already carries one label per `InputMode` value. */
const MODE_LABEL_PREFIX = "live.inputPicker.groups.";

/** The dotted i18n key naming a capture format, for every `InputMode` member. */
export function inputModeLabelKey(mode: InputMode): string {
	return `${MODE_LABEL_PREFIX}${mode}`;
}

/**
 * The mode families this source offers the operator, or `[]`.
 *
 * A single family is NOT a choice — the row's own kind badge already names it —
 * so only a genuinely multi-format device returns options. Absent `inputModes`
 * (a pre-0.11.0 engine) reads as "no ladder split was reported", never as "no
 * modes", so it also returns `[]` and nothing is rendered.
 */
export function captureModeOptions(
	source: StreamSource | undefined,
): readonly CaptureInputMode[] {
	if (source?.origin !== "capture") return [];
	const modes = source.inputModes;
	return modes !== undefined && modes.length >= 2 ? modes : [];
}

/**
 * The format governing this source right now, honouring an unsaved draft pick.
 *
 * The pick is trusted only while the device still ADVERTISES it: a mode carried
 * over from other hardware must not narrow a ladder it has nothing to do with.
 * Falls through to the engine's own `selectedInputMode` (which IS its
 * highest-precedence mode), then to nothing — and nothing narrows.
 */
export function governingInputMode(
	source: StreamSource | undefined,
	draft?: InputMode | undefined,
): InputMode | undefined {
	if (source?.origin !== "capture") return undefined;
	const selected = draft ?? source.selectedInputMode;
	if (
		selected !== undefined &&
		source.inputModes?.some((mode) => mode.inputMode === selected) === true
	) {
		return selected;
	}
	return source.selectedInputMode;
}

/** The advertised family the governing format names, if the device split them. */
function governingFamily(
	source: StreamSource | undefined,
	draft?: InputMode | undefined,
): CaptureInputMode | undefined {
	if (source?.origin !== "capture") return undefined;
	const mode = governingInputMode(source, draft);
	if (mode === undefined) return undefined;
	return source.inputModes?.find((entry) => entry.inputMode === mode);
}

/**
 * The ladder that belongs to the governing format ALONE, or `undefined` when the
 * device reported no per-format split (the caller then keeps `source.modes`).
 *
 * Returning the family's own `modes` is what stops the encoder dialog offering a
 * rung only the OTHER format can deliver — the union lie ADR-0008 §10 forbids.
 */
export function ladderForInputMode(
	source: StreamSource | undefined,
	draft?: InputMode | undefined,
): readonly DeviceMode[] | undefined {
	const family = governingFamily(source, draft);
	// An EMPTY family ladder is not a narrowing to nothing — it is a family the
	// engine enumerated no rungs for, so the caller must keep the flat list
	// (fail-open: an unknown never subtracts).
	return family !== undefined && family.modes.length > 0
		? family.modes
		: undefined;
}

/**
 * The media type the governing format negotiates, as the ENGINE declared it.
 *
 * Once a ladder has been scoped to one family it carries a single media type, and
 * the shared `activeMediaTypeForModes` rule deliberately narrows nothing below two
 * — so the scoped answer has to come from the family's own `mediaType` rather than
 * be re-inferred from the rungs that survived.
 */
export function mediaTypeForInputMode(
	source: StreamSource | undefined,
	draft?: InputMode | undefined,
): string | undefined {
	return governingFamily(source, draft)?.mediaType;
}
