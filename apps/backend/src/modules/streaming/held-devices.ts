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
 * Which capture kinds make the local `/dev/videoN` scan an INVALID presence
 * oracle — the CeraUI-side mirror of cerastream's `engine::held_devices`.
 *
 * `libuvch264src` does not open a v4l2 node at all: it drives its camera through
 * libuvc, i.e. through usbfs, which unbinds the kernel `uvcvideo` driver from the
 * USB interface for the whole session. So while the engine is capturing or
 * previewing such a camera the node is LEGITIMATELY gone, and on release the
 * device comes back under a DIFFERENT number (`/dev/video1` → `/dev/video2` → …).
 * For those kinds, absence from `/dev` is what a working capture looks like —
 * not a disconnect.
 *
 * cerastream already knows this on its own side: a leg whose resolved
 * `InputKind` is `UvcH264`/`UvcH265` records the device it holds, and both
 * `capture_rebind_tick` and `list_devices` union that set over the v4l2 registry
 * (cerastream PR #84 for the streaming leg, PR #86 for the idle preview). CeraUI
 * has a SECOND, independent presence signal — the device registry's own
 * `/sys/class/video4linux` scan — which had no such notion, so it kept reporting
 * a camera the engine was actively serving as `lost`.
 *
 * SCOPING: keyed on the resolved device KIND, exactly like the engine's rule.
 * Never on a vendor id, product id, serial, or display name — every UVC-H.264 /
 * H.265 camera behaves this way, and no other kind does.
 */

import type { DeviceKind } from "@ceraui/rpc/schemas";

/**
 * The kinds `deviceKindToPipelineId` bridges to the `libuvch264` pipeline — the
 * one pipeline whose source element is libuvc-driven rather than v4l2-driven.
 */
const V4L2_NODE_RELEASING_KINDS: ReadonlySet<DeviceKind> = new Set<DeviceKind>([
	"uvc_h264",
	"uvc_h265",
]);

/**
 * Does opening this device release (unbind) its kernel v4l2 node?
 *
 * `true` means CeraUI's own `/dev` scan cannot answer "is it plugged in" for
 * this device, and only the engine can. `false` — every other kind, and an
 * absent/unknown kind — keeps the byte-identical observation-wins behaviour.
 */
export function releasesV4l2Node(kind: DeviceKind | undefined): boolean {
	return kind !== undefined && V4L2_NODE_RELEASING_KINDS.has(kind);
}
