# APT fixture provenance

- `opi-nginx-20261022.txt` is the unchanged 149-line read-only Orange Pi capture
  from 2026-10-22: SIM, HOLDS, global POLICY, per-package PKG and observed nginx
  facts. Framing alone is removed by the loader; row-ending spaces survive.
- `install-weak-dependencies.txt` combines apt-get's real English output headings
  and simulation banner with the independent reviewer's `libfoo2`/`nginx` plan.
  It is an install-shaped replay, **not a second board capture**. The Suggested/
  Recommended headings were observed in real non-TTY apt-get launcher output;
  [apt 3.0.3 ShowWeakDependencies / DoInstall](https://github.com/Debian/apt/blob/45bebdfb891535d15e66e860aab1ee7c7b2ecaab/apt-private/private-install.cc#L1169-L1299)
  is the immutable producer reference. Indented suggested/recommended names
  must never become install targets.
- `apt-all-install-prose.test.ts` retains all 54 literals from the review's apt
  3.0.3 source census. Seven action-token literals are refusal cases; the other
  47 are prose/debug/diagnostic strings tested as non-authoritative context.
  Error prose in this census does not authorize a failed command: exit status
  is checked by the caller before parsing simulation stdout.
