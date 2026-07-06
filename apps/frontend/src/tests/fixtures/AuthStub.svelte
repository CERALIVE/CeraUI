<!--
  AuthStub.svelte — an identifiable stand-in for Auth.svelte in unit tests.

  Unlike the generic Noop, this renders a single testid-bearing element so a
  test can assert the auth gate fell through to the password screen (e.g. after
  clearing a stale saved credential) without mounting the real Auth subscription
  graph.
-->
<div data-testid="auth-screen">auth-screen</div>
