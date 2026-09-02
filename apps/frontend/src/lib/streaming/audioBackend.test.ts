/**
 * The offer rule for the engine audio backend.
 *
 * Every case here is a defect the module exists to prevent, so the tables are
 * written against the FOUR rules in its header rather than against its shape:
 * never offer an unlisted backend, never render absent as `alsa`, render nothing
 * when the engine stated nothing, and never dress a single arm as a choice.
 */
import type { MessageFn, MessageKey } from "@ceraui/i18n/svelte";
import type { AudioBackend } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	AUDIO_BACKEND_UNSUPPORTED_ERROR,
	type AudioBackendCapability,
	audioBackendLabel,
	audioBackendSaveErrorMessage,
	canSelectAudioBackend,
	deriveAudioBackendView,
} from "./audioBackend";

const UNSUPPORTED_COPY = "unsupported-copy";
const GENERIC_COPY = "generic-copy";

/** A keyed-lookup stub: only the two keys the error mapper can reach. */
function stubMessages(): Readonly<Record<MessageKey, MessageFn>> {
	return new Proxy({} as Record<MessageKey, MessageFn>, {
		get: (_target, key: string) =>
			key === "settings.audioBackend.errorUnsupported"
				? () => UNSUPPORTED_COPY
				: () => GENERIC_COPY,
	});
}

function capability(
	supported: readonly AudioBackend[],
	active: AudioBackend,
): AudioBackendCapability {
	return { supported: [...supported], active };
}

function view(
	supported: readonly AudioBackend[] | undefined,
	active: AudioBackend = "pipewire",
	selection?: AudioBackend,
) {
	return deriveAudioBackendView({
		capability:
			supported === undefined ? undefined : capability(supported, active),
		selection,
	});
}

describe("deriveAudioBackendView — rule 3: an absent capability offers NOTHING", () => {
	it("renders zero options when the engine stated no capability block", () => {
		const result = view(undefined);
		expect(result.mode).toBe("absent");
		expect(result.options).toEqual([]);
		expect(result.active).toBeUndefined();
		expect(result.selected).toBeUndefined();
		expect(result.disabledReasonKey).toBeUndefined();
	});

	it("treats a block advertising no supported backend as absent, not as a choice", () => {
		// A capability that names an active arm while supporting none is
		// contradictory; the honest reading is that nothing may be offered.
		const result = view([], "alsa");
		expect(result.mode).toBe("absent");
		expect(result.options).toEqual([]);
	});

	it("is absent even when a selection IS stored — a stored pick never conjures an offering", () => {
		const result = view(undefined, "alsa", "pipewire");
		expect(result.mode).toBe("absent");
		expect(result.options).toEqual([]);
	});
});

describe("deriveAudioBackendView — rule 4: one supported backend is a state, not a choice", () => {
	it("renders the single arm disabled, with a reason key", () => {
		const result = view(["alsa"], "alsa");
		expect(result.mode).toBe("single");
		expect(result.options.map((o) => o.backend)).toEqual(["alsa"]);
		expect(result.disabledReasonKey).toBe("settings.audioBackend.singleReason");
	});

	it("still names which arm is running, so the operator learns the fact", () => {
		const result = view(["alsa"], "alsa");
		expect(result.active).toBe("alsa");
		expect(result.options[0]?.active).toBe(true);
		expect(result.options[0]?.selected).toBe(true);
	});
});

describe("deriveAudioBackendView — rule 2: ABSENT is the engine's default, never `alsa`", () => {
	it("rests on the engine's own active arm when nothing was ever stated", () => {
		const result = view(["alsa", "pipewire"], "pipewire");
		expect(result.selected).toBe("pipewire");
		expect(result.stated).toBe(false);
		expect(result.options.find((o) => o.backend === "alsa")?.selected).toBe(
			false,
		);
		expect(result.appliesNextStart).toBe(false);
	});

	it("does NOT pre-select the first enum member on an alsa-running engine either", () => {
		// The mirror control: `alsa` is only ever selected because the ENGINE says
		// it is running, so this passing for the right reason matters.
		const result = view(["alsa", "pipewire"], "alsa");
		expect(result.selected).toBe("alsa");
		expect(result.stated).toBe(false);
	});

	it("prefers a stated selection over the running arm and flags the next-start change", () => {
		const result = view(["alsa", "pipewire"], "pipewire", "alsa");
		expect(result.selected).toBe("alsa");
		expect(result.stated).toBe(true);
		expect(result.active).toBe("pipewire");
		expect(result.appliesNextStart).toBe(true);
	});

	it("does not flag a next-start change when the stated pick already runs", () => {
		const result = view(["alsa", "pipewire"], "pipewire", "pipewire");
		expect(result.stated).toBe(true);
		expect(result.appliesNextStart).toBe(false);
	});
});

describe("deriveAudioBackendView — rule 1: an unlisted backend is never offered", () => {
	it("offers exactly the advertised set, in payload order", () => {
		const result = view(["pipewire", "alsa"], "pipewire");
		expect(result.options.map((o) => o.backend)).toEqual(["pipewire", "alsa"]);
	});

	it("reports a stored selection the engine no longer advertises without offering it", () => {
		const result = view(["alsa"], "alsa", "pipewire");
		expect(result.staleSelection).toBe("pipewire");
		expect(result.options.map((o) => o.backend)).toEqual(["alsa"]);
		expect(result.options.some((o) => o.backend === "pipewire")).toBe(false);
	});

	it("falls the rendered selection back to the running arm when the stored one is stale", () => {
		const result = view(["alsa"], "alsa", "pipewire");
		expect(result.selected).toBe("alsa");
	});

	it("reports no stale selection when the stored pick is advertised", () => {
		expect(
			view(["alsa", "pipewire"], "pipewire", "alsa").staleSelection,
		).toBeUndefined();
	});
});

describe("canSelectAudioBackend — the device's own gate, mirrored", () => {
	it("admits an advertised backend that is not already selected", () => {
		expect(
			canSelectAudioBackend(view(["alsa", "pipewire"], "pipewire"), "alsa"),
		).toBe(true);
	});

	it("refuses the backend already selected — a no-op dressed as a choice", () => {
		expect(
			canSelectAudioBackend(view(["alsa", "pipewire"], "pipewire"), "pipewire"),
		).toBe(false);
	});

	it("refuses an unadvertised backend, which is the write the device would refuse", () => {
		expect(canSelectAudioBackend(view(["alsa"], "alsa"), "pipewire")).toBe(
			false,
		);
	});

	it("refuses everything while the offering is absent or single", () => {
		expect(canSelectAudioBackend(view(undefined), "alsa")).toBe(false);
		expect(canSelectAudioBackend(view(["alsa"], "alsa"), "alsa")).toBe(false);
	});
});

describe("audioBackendSaveErrorMessage", () => {
	it("names the actual cause for the device's typed refusal", () => {
		expect(
			audioBackendSaveErrorMessage(
				AUDIO_BACKEND_UNSUPPORTED_ERROR,
				stubMessages(),
			),
		).toBe(UNSUPPORTED_COPY);
	});

	it("mirrors the device's wire token verbatim", () => {
		expect(AUDIO_BACKEND_UNSUPPORTED_ERROR).toBe("audio_backend_unsupported");
	});

	it("falls back to the generic failure copy for anything else", () => {
		expect(audioBackendSaveErrorMessage("device_offline", stubMessages())).toBe(
			GENERIC_COPY,
		);
		expect(audioBackendSaveErrorMessage(undefined, stubMessages())).toBe(
			GENERIC_COPY,
		);
	});
});

describe("audioBackendLabel", () => {
	it("renders each subsystem's own proper noun", () => {
		expect(audioBackendLabel("alsa")).toBe("ALSA");
		expect(audioBackendLabel("pipewire")).toBe("PipeWire");
	});
});
