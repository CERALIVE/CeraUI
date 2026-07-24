/*
 * Operator-facing audio-device naming (device-quality-wave2).
 *
 * The two live-reported regressions this locks, captured verbatim from the
 * reporting board's `/proc/asound/cards` and cerastream `list-devices`:
 *
 *   card 5 usbaudio  "RØDE RØDE HDMI to USB-C at usb-xhci-hcd.17.auto-1, super speed"
 *   card 6 MINI      "DJI Technology Co., Ltd. DJI MIC MINI at usb-fc8c0000.usb-1, full speed"
 *
 * The RØDE leaked through TIER 1 (cerastream sets an audio entry's `display_name`
 * to the ALSA longname verbatim, and its `product_name` was the generic
 * "usbaudio" the human-name heuristic rejects); the DJI leaked through TIER 2
 * (no engine entry at all, so the raw `/proc/asound/cards` longname was used).
 * Both tiers are now cleaned, and the raw string is preserved as `detail`.
 */
import { describe, expect, test } from "bun:test";
import {
	audioAliasKey,
	cleanAudioDeviceName,
	type EngineAudioDevice,
	resolveAudioDisplays,
} from "../modules/streaming/audio-naming.ts";

const RODE_LONGNAME =
	"RØDE RØDE HDMI to USB-C at usb-xhci-hcd.17.auto-1, super speed";
const DJI_LONGNAME =
	"DJI Technology Co., Ltd. DJI MIC MINI at usb-fc8c0000.usb-1, full speed";

describe("cleanAudioDeviceName — bus/speed suffix", () => {
	test("strips the kernel `at <bus-path>, <speed> speed` tail and keeps it as detail", () => {
		expect(cleanAudioDeviceName(DJI_LONGNAME)).toEqual({
			name: "DJI MIC MINI",
			detail: DJI_LONGNAME,
		});
	});

	test("handles every USB link speed the kernel emits", () => {
		for (const speed of ["low", "full", "high", "super", "super+"]) {
			expect(
				cleanAudioDeviceName(`Acme Mic at usb-fc8c0000.usb-1, ${speed} speed`)
					.name,
			).toBe("Acme Mic");
		}
	});

	test("leaves a product name that merely CONTAINS ' at ' untouched", () => {
		const raw = "Sound at Work Studio Mic";
		expect(cleanAudioDeviceName(raw)).toEqual({ name: raw });
	});

	test("leaves an ' at <path>' with no trailing speed word untouched", () => {
		const raw = "Acme Mic at usb-fc8c0000.usb-1";
		expect(cleanAudioDeviceName(raw)).toEqual({ name: raw });
	});
});

describe("cleanAudioDeviceName — duplicated manufacturer prefix", () => {
	test("drops an immediately repeated manufacturer token", () => {
		expect(cleanAudioDeviceName(RODE_LONGNAME)).toEqual({
			name: "RØDE HDMI to USB-C",
			detail: RODE_LONGNAME,
		});
	});

	test("drops a repeat bridged only by corporate filler", () => {
		expect(
			cleanAudioDeviceName("DJI Technology Co., Ltd. DJI MIC MINI").name,
		).toBe("DJI MIC MINI");
	});

	test("matches the manufacturer case-insensitively, keeping the survivor's casing", () => {
		expect(cleanAudioDeviceName("Elgato ELGATO Wave XLR").name).toBe(
			"ELGATO Wave XLR",
		);
	});

	test("ignores punctuation when comparing tokens", () => {
		expect(cleanAudioDeviceName("Acme, Acme Studio Mic").name).toBe(
			"Acme Studio Mic",
		);
	});

	// Ø (U+00D8) is a distinct letter, not a decomposable diacritic, so
	// "Rode"/"RØDE" are genuinely different tokens. Collapsing them would need a
	// vendor-specific transliteration table — deliberately out of scope, since a
	// wrong collapse silently mangles a real product name.
	test("does NOT collapse a prefix that differs by more than case", () => {
		const raw = "Rode RØDE NT-USB";
		expect(cleanAudioDeviceName(raw)).toEqual({ name: raw });
	});

	test("does NOT collapse a product name that legitimately repeats a word", () => {
		for (const raw of [
			"Blue Microphones Yeti Blue",
			"Focusrite Scarlett Solo",
			"Elgato Cam Link 4K",
			"Shure MV7 Podcast Microphone",
		]) {
			expect(cleanAudioDeviceName(raw)).toEqual({ name: raw });
		}
	});

	test("never empties a single-token or repeated-only name", () => {
		expect(cleanAudioDeviceName("usbaudio")).toEqual({ name: "usbaudio" });
		expect(cleanAudioDeviceName("RØDE RØDE").name).toBe("RØDE RØDE");
	});

	test("is idempotent — cleaning a cleaned name is a no-op", () => {
		for (const raw of [RODE_LONGNAME, DJI_LONGNAME]) {
			const once = cleanAudioDeviceName(raw).name;
			expect(cleanAudioDeviceName(once)).toEqual({ name: once });
		}
	});
});

describe("audioAliasKey — stable identity, never the bus path", () => {
	test("prefers the engine stable_id", () => {
		expect(audioAliasKey("usbaudio", "usb:19f7:0080:OC0001967")).toBe(
			"usb:19f7:0080:OC0001967",
		);
	});

	test("falls back to the namespaced ALSA card id", () => {
		expect(audioAliasKey("MINI")).toBe("card:MINI");
		expect(audioAliasKey("MINI", "")).toBe("card:MINI");
	});

	test("never contains the volatile USB bus path", () => {
		expect(audioAliasKey("usbaudio")).not.toContain("usb-xhci-hcd");
	});
});

describe("resolveAudioDisplays — the live board scenario", () => {
	const cards = {
		HDMI: "rockchiphdmiin",
		"USB audio": "usbaudio",
		MINI: "MINI",
	};
	// The RØDE as cerastream actually reports it: display_name IS the longname,
	// and product_name is the generic card id the heuristic rejects.
	const engine: EngineAudioDevice[] = [
		{
			input_id: RODE_LONGNAME,
			display_name: RODE_LONGNAME,
			alsa_card_id: "usbaudio",
			product_name: "usbaudio",
			transport: "usb",
			stable_id: "card:usbaudio",
		},
	];
	const longnames = new Map([
		["rockchiphdmiin", "rockchip,hdmiin"],
		["usbaudio", RODE_LONGNAME],
		["MINI", DJI_LONGNAME],
	]);

	test("cleans the tier-1 leak (RØDE) and preserves the raw string as detail", () => {
		const display = resolveAudioDisplays(cards, engine, longnames).get(
			"USB audio",
		);
		expect(display?.label).toBe("RØDE HDMI to USB-C");
		expect(display?.detail).toBe(RODE_LONGNAME);
		expect(display?.aliasKey).toBe("card:usbaudio");
		expect(display?.alias).toBeUndefined();
	});

	test("cleans the tier-2 leak (DJI Mic Mini) with no engine entry at all", () => {
		const display = resolveAudioDisplays(cards, engine, longnames).get("MINI");
		expect(display?.label).toBe("DJI MIC MINI");
		expect(display?.detail).toBe(DJI_LONGNAME);
		expect(display?.aliasKey).toBe("card:MINI");
	});

	test("leaves a longname that needs no cleaning untouched and detail-free", () => {
		const display = resolveAudioDisplays(cards, engine, longnames).get("HDMI");
		expect(display?.label).toBe("rockchip,hdmiin");
		expect(display?.detail).toBeUndefined();
	});
});

describe("resolveAudioDisplays — tier-0 operator alias", () => {
	const cards = { "USB audio": "usbaudio", MINI: "MINI" };
	const longnames = new Map([
		["usbaudio", RODE_LONGNAME],
		["MINI", DJI_LONGNAME],
	]);

	test("an alias outranks every hardware-derived tier", () => {
		const display = resolveAudioDisplays(cards, [], longnames, {
			"card:MINI": "Presenter mic",
		}).get("MINI");
		expect(display?.label).toBe("Presenter mic");
		expect(display?.alias).toBe("Presenter mic");
	});

	test("the replaced hardware name survives as detail", () => {
		const display = resolveAudioDisplays(cards, [], longnames, {
			"card:MINI": "Presenter mic",
		}).get("MINI");
		expect(display?.detail).toBe(DJI_LONGNAME);
	});

	test("an alias keyed on the engine stable_id applies to its card", () => {
		const engine: EngineAudioDevice[] = [
			{
				input_id: "audio:usbaudio",
				display_name: RODE_LONGNAME,
				alsa_card_id: "usbaudio",
				stable_id: "usb:19f7:0080:OC0001967",
			},
		];
		const display = resolveAudioDisplays(cards, engine, longnames, {
			"usb:19f7:0080:OC0001967": "Camera A",
		}).get("USB audio");
		expect(display?.label).toBe("Camera A");
	});

	test("an alias for another device never bleeds across cards", () => {
		const displays = resolveAudioDisplays(cards, [], longnames, {
			"card:MINI": "Presenter mic",
		});
		expect(displays.get("USB audio")?.label).toBe("RØDE HDMI to USB-C");
		expect(displays.get("USB audio")?.alias).toBeUndefined();
	});

	test("a blank/whitespace alias is ignored — the hardware name is restored", () => {
		for (const blank of ["", "   "]) {
			const display = resolveAudioDisplays(cards, [], longnames, {
				"card:MINI": blank,
			}).get("MINI");
			expect(display?.label).toBe("DJI MIC MINI");
			expect(display?.alias).toBeUndefined();
		}
	});

	test("an alias for a device that is not present is simply unused", () => {
		const displays = resolveAudioDisplays(cards, [], longnames, {
			"card:GONE": "Unplugged mic",
		});
		expect([...displays.keys()]).toEqual(["USB audio", "MINI"]);
	});

	test("two devices renamed to the SAME label still dedupe", () => {
		const displays = resolveAudioDisplays(cards, [], longnames, {
			"card:usbaudio": "Mic",
			"card:MINI": "Mic",
		});
		expect(displays.get("USB audio")?.label).toBe("Mic");
		expect(displays.get("MINI")?.label).toBe("Mic (2)");
	});
});
