<!--
  OfflinePageStub.svelte — an identifiable stand-in for OfflinePage in unit tests.

  Unlike the generic Noop, this renders a single testid-bearing element so a test
  can assert the full-page takeover actually replaced the screen, rather than
  only that the pre-auth screen survived. It carries the same testid the real
  component does, so a Layout-level assertion reads identically against either.
-->
<div data-testid="offline-page">offline-page</div>
