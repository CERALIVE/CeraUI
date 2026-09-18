# Dependency update #364

## TypeScript 7 is held back

The root now uses `typescript: "catalog:"`, like the four workspaces. The
catalog remains `^6.0.3`, locked to 6.0.3. The other 15 package upgrades remain
in the PR; this is deliberately not a TypeScript 7 migration.

TypeScript 7.0.2's JavaScript entry exports only `version` and
`versionMajorMinor`. The frontend test classifier and the Build Check workflow
contract use `createSourceFile` and `ScriptTarget.Latest`; both are absent.
All four frontend shards, the report merger and the workflow-shape guard
therefore failed before running their contracts. Replacing assertions or
loosening types would not restore the parser.

Microsoft explicitly states that [TypeScript 7.0 does not ship with an
API](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0).
Its suggested TypeScript 6 compatibility package is a migration option, not a
reason to install two compilers in a dependency-refresh PR. CeraUI already
reserves TypeScript 7 for a separately owned migration in `AGENTS.md`.

## Modem-control's exact-version contract follows the release

`@ceralive/modem-control` advances from 1.3.0 to 1.4.0. The [release change
record](https://github.com/CERALIVE/modem-stack/commit/9a4ff88ed1059aae65ef0608cdba6620ed07c3fb)
moves Debian packaging to Trixie. The complete `v1.3.0...v1.4.0` source diff
under `control/` changes only `package.json`'s version; projection source and
export contracts are unchanged.

The backend test's old exact `1.3.0` expectation was consequently stale. It now
requires exactly `1.4.0`, with the release citation beside it. Every projection
import and the frozen transport boundary remain asserted. No package behavior
assertion, type, test, workflow step, or CI condition is relaxed.

## Lucide's exact DOM goldens follow its shared renderer

Once Vitest could start, two exact DOM comparisons exposed Lucide's intentional
renderer change, not a product regression. [Lucide 1.42.0's
changelog](https://github.com/lucide-icons/lucide/releases/tag/1.42.0) records
“extract icon build logic into `@lucide/shared`” ([#4409](https://github.com/lucide-icons/lucide/pull/4409),
commit `99d25bdee231922e73e19525f57a585d1682fab2`). The 1.46.0 upgrade includes it.

The shared builder emits `lucide lucide-<name> lucide-icon` instead of
`lucide-icon lucide lucide-<name>` and places the `class` attribute before
`aria-hidden`. The InputPicker snapshot changes only those orders for two SVGs;
the Ethernet plain-row golden changes only the class-token order for two SVGs.
Both tests retain their exact comparisons, all accessibility attributes and
all geometry. Their comments cite the upstream changelog. No serializer or
normalization rule was weakened to hide the diff.
