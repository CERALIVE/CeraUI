/**
 * The CLI-managed `Switch` (never hand-edited) slides a checked thumb toward the
 * physical right even in RTL, where it leaves the track: its size-specific
 * translate outranks the primitive's own `rtl:` rule. A caller adds this class to
 * mirror the checked thumb inside the track. bits-ui marks the thumb with
 * `data-state`, never a bare `data-checked` (see `app.css`).
 */
export const RTL_SWITCH_THUMB =
	"rtl:[&_[data-slot=switch-thumb][data-state=checked]]:-translate-x-[calc(100%-2px)]!";
