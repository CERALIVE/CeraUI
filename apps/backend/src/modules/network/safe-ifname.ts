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

/*
  The ONE rule for an interface name that is about to reach an argv slot.

  It lives in a LEAF module — no imports, of anything — because every
  `curl --interface` site needs it and those sites sit at opposite ends of the
  network graph. It used to live in `device-bound-probe.ts`, which made
  `router-cellular-admin.ts` import that module purely for this constant and
  closed a real cycle: `device-bound-probe -> mock-service -> … ->
  network-interfaces -> router-cellular-admin -> device-bound-probe`. The cycle
  is latent rather than harmless — it throws `Cannot access 'SAFE_IFNAME_RE'
  before initialization` whenever `device-bound-probe.ts` happens to be the
  module that ENTERS it, which is exactly what any consumer importing the probe
  first does. Moving the constant to a leaf removes the edge that closed it.

  `device-bound-probe.ts` re-exports both names, so every existing importer is
  unchanged and the "one rule, never a second copy" contract is unaffected.
*/

/**
 * `argMatch(ID_RE, …)`-equivalent, plus the kernel's own 15-character
 * `IFNAMSIZ` ceiling. The FIRST character deliberately excludes `-`, mirroring
 * `argMatch`'s separate `startsWith("-")` refusal: a name like `--upload-file`
 * is otherwise a well-formed member of the character class and would be read by
 * curl as a flag rather than as the value of `--interface`.
 */
export const SAFE_IFNAME_RE: RegExp = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,14}$/;

export function isSafeIfname(ifname: string): boolean {
	return SAFE_IFNAME_RE.test(ifname);
}
