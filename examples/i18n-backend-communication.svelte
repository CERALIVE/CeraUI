<script lang="ts">
  import { i18n } from '$lib/stores/i18n.svelte.ts';

  // =============================================================================
  // 🎯 TYPE-SAFE ACCESS (for backend communication)
  // =============================================================================

  // Get translation KEY for backend (not the translated value)
  const passwordErrorKey = i18n.t.auth.validation.passwordMinLength.getKey();
  // Returns: "auth.validation.passwordMinLength"

  // Get translated VALUE for display
  const passwordErrorMsg = i18n.t.auth.validation.passwordMinLength.getValue();
  // Returns: "Password must be at least 8 characters"

  // Template literals with parameters
  const streamingKey = i18n.t.general.streamingMessage.getKey();
  const streamingMsg = i18n.t.general.streamingMessage.getValue({
    usingNetworksCount: 2,
    srtLatency: 150
  });

  // =============================================================================
  // 🔤 STRING-BASED ACCESS (traditional)
  // =============================================================================

  const titleStr = i18n.useKey('updatingOverlay.title');
  const streamingStr = i18n.useKey('general.streamingMessage', {
    usingNetworksCount: 3,
    srtLatency: 200
  });

  // =============================================================================
  // 🚀 BACKEND COMMUNICATION EXAMPLES
  // =============================================================================

  async function logValidationError() {
    // Send KEY to backend, not translated value
    await fetch('/api/log-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        errorKey: i18n.t.auth.validation.passwordMinLength.getKey(),
        errorContext: 'user-registration',
        timestamp: Date.now()
        // Backend can:
        // 1. Log the key for debugging
        // 2. Store in database for analytics  
        // 3. Translate for different clients
        // 4. Use for error categorization
      })
    });
  }

  async function sendFormValidation() {
    const errors = [];
    
    // Collect validation error KEYS (not translated messages)
    if (password.length < 8) {
      errors.push(i18n.t.auth.validation.passwordMinLength.getKey());
    }
    
    if (!isValidEmail(email)) {
      errors.push(i18n.t.auth.validation.emailInvalid?.getKey() || 'auth.validation.emailInvalid');
    }

    // Send to backend for processing
    await fetch('/api/validate-form', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        formType: 'registration',
        validationErrors: errors, // Array of keys like ["auth.validation.passwordMinLength"]
        // Backend can translate these for different clients/languages
      })
    });
  }

  // =============================================================================
  // 🔄 RUNTIME EXAMPLES
  // =============================================================================

  let password = '';
  let email = '';

  function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // Display translated messages to user
  $: passwordError = password.length > 0 && password.length < 8 
    ? i18n.t.auth.validation.passwordMinLength.getValue()
    : '';

  $: emailError = email.length > 0 && !isValidEmail(email)
    ? 'Invalid email format'
    : '';
</script>

<!-- =============================================================================
     UI DEMONSTRATION
     ============================================================================= -->

<div class="p-6 max-w-2xl mx-auto space-y-6">
  <h1 class="text-2xl font-bold">🌐 i18n Backend Communication Demo</h1>
  
  <!-- Type-safe Access Examples -->
  <section class="space-y-4">
    <h2 class="text-xl font-semibold">🎯 Type-safe Access</h2>
    
    <div class="bg-gray-100 p-4 rounded">
      <p><strong>Key:</strong> {passwordErrorKey}</p>
      <p><strong>Value:</strong> {passwordErrorMsg}</p>
    </div>
    
    <div class="bg-blue-100 p-4 rounded">
      <p><strong>Template Key:</strong> {streamingKey}</p>
      <p><strong>Template Value:</strong> {streamingMsg}</p>
    </div>
  </section>

  <!-- String-based Access Examples -->
  <section class="space-y-4">
    <h2 class="text-xl font-semibold">🔤 String-based Access</h2>
    
    <div class="bg-green-100 p-4 rounded">
      <p><strong>Title:</strong> {titleStr}</p>
      <p><strong>Streaming:</strong> {streamingStr}</p>
    </div>
  </section>

  <!-- Live Form Example -->
  <section class="space-y-4">
    <h2 class="text-xl font-semibold">📝 Live Form Validation</h2>
    
    <div class="space-y-2">
      <input 
        bind:value={password} 
        type="password" 
        placeholder="Password" 
        class="w-full p-2 border rounded"
      />
      {#if passwordError}
        <p class="text-red-600 text-sm">{passwordError}</p>
      {/if}
    </div>
    
    <div class="space-y-2">
      <input 
        bind:value={email} 
        type="email" 
        placeholder="Email" 
        class="w-full p-2 border rounded"
      />
      {#if emailError}
        <p class="text-red-600 text-sm">{emailError}</p>
      {/if}
    </div>

    <div class="flex gap-2">
      <button 
        onclick={logValidationError}
        class="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
      >
        Log Error Key
      </button>
      
      <button 
        onclick={sendFormValidation}
        class="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
      >
        Send Validation
      </button>
    </div>
  </section>

  <!-- Benefits Summary -->
  <section class="bg-yellow-50 p-4 rounded">
    <h3 class="font-semibold mb-2">✨ Benefits for Backend Communication:</h3>
    <ul class="space-y-1 text-sm">
      <li>• <strong>Type Safety:</strong> Full IntelliSense and compile-time checking</li>
      <li>• <strong>Backend Keys:</strong> Send translation keys, not translated values</li>
      <li>• <strong>Multi-client:</strong> Backend can translate for different languages</li>
      <li>• <strong>Logging:</strong> Structured error keys for analytics</li>
      <li>• <strong>Refactor-safe:</strong> Renames propagate correctly</li>
      <li>• <strong>Flexibility:</strong> Both type-safe and string-based access</li>
    </ul>
  </section>
</div>