# Production notification coverage [EXISTS]

Run `bun scripts/ci/notification-bundle.ts` after a production SPA build. An
optional argument selects another **trusted** built assets directory. The guard
executes emitted JavaScript; do not point it at an untrusted bundle.

The TypeScript parser collects complete `notifications.*` literals from backend
production source, including constants and event/reason tables. It also covers
the existing out-of-namespace notification `network.os.deviceBusy`. Tests and
mocks do not define the production requirement. Computed notification template
or concatenation families are refused: enumerate their complete keys instead.
New non-notification-namespace emissions need an explicit scanner extension.

For every locale in the inlang settings, the guard imports the real emitted
namespace chunk and calls each required message with distinct placeholder values
and an explicit locale. It compares the result with the corresponding JSON
catalog pattern. Missing functions, wrong copy, wrong locale dispatch and wrong
interpolation fail. It never imports the generated source registry, eager test
registration or sourcemaps. An empty scan or missing/ambiguous namespace chunk
also fails rather than passing vacuously.

The chunk naming/export contract is intentional: a bundler-layout change must
update the guard, not silently fall back to source translations. Notification
patterns are currently strings; a future plural/select pattern needs explicit
variant coverage before the guard can accept it.

`scripts/ci/tsconfig.json` type-checks the TypeScript guards using the existing
root Node and backend Bun type packages; it introduces no dependency. The
release-package contract suite runs that check alongside the guard tests.

This is build-artifact coverage, not browser-cache, deployed-package provenance
or installed-board qualification. The frontend unit test separately drives the
real facade and notification resolver in every locale. No label or translation
is changed; English and es-419 user documentation is unaffected.
