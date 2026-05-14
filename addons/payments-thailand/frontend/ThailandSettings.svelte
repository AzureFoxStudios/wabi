<script lang="ts">
    let promptPayProxyId = '';
    let merchantName = 'WABI';
    let merchantCity = 'BANGKOK';
    let adapterBaseUrl = '';
    let adapterToken = '';
    let adapterSigningSecret = '';
    let adapterTimeout = 10000;
    let webhookSecret = 'th-payments-dev-webhook-secret';
    let saved = false;

    function handleSave() {
        saved = true;
        setTimeout(() => {
            saved = false;
        }, 2000);
    }
</script>

<div class="thailand-settings">
    <div class="header">
        <h3>Thailand Payments</h3>
        <span class="badge">THB</span>
    </div>

    <div class="section">
        <h4>PromptPay QR</h4>
        <div class="field">
            <label for="promptPayProxyId">Server PromptPay Proxy ID</label>
            <input
                id="promptPayProxyId"
                type="text"
                bind:value={promptPayProxyId}
                placeholder="0XXXXXXXXX or national ID"
            />
            <span class="hint">Used for server donations. Leave empty to disable.</span>
        </div>
        <div class="field">
            <label for="merchantName">Merchant Name</label>
            <input
                id="merchantName"
                type="text"
                bind:value={merchantName}
                placeholder="WABI"
            />
        </div>
        <div class="field">
            <label for="merchantCity">Merchant City</label>
            <input
                id="merchantCity"
                type="text"
                bind:value={merchantCity}
                placeholder="BANGKOK"
            />
        </div>
    </div>

    <div class="section">
        <h4>PSP Adapter</h4>
        <div class="field">
            <label for="adapterBaseUrl">Adapter Base URL</label>
            <input
                id="adapterBaseUrl"
                type="url"
                bind:value={adapterBaseUrl}
                placeholder="https://..."
            />
            <span class="hint">Configure to enable PSP checkout for Thai banks.</span>
        </div>
        <div class="field">
            <label for="adapterToken">Adapter Token</label>
            <input
                id="adapterToken"
                type="password"
                bind:value={adapterToken}
                placeholder="Bearer token"
            />
        </div>
        <div class="field">
            <label for="adapterSigningSecret">Signing Secret</label>
            <input
                id="adapterSigningSecret"
                type="password"
                bind:value={adapterSigningSecret}
                placeholder="HMAC signing key"
            />
        </div>
        <div class="field">
            <label for="adapterTimeout">Timeout (ms)</label>
            <input
                id="adapterTimeout"
                type="number"
                bind:value={adapterTimeout}
                min="1000"
                max="60000"
            />
        </div>
    </div>

    <div class="section">
        <h4>Webhooks</h4>
        <div class="field">
            <label for="webhookSecret">Webhook Secret</label>
            <input
                id="webhookSecret"
                type="text"
                bind:value={webhookSecret}
            />
        </div>
    </div>

    <div class="actions">
        <button class="save-btn" on:click={handleSave}>
            {saved ? 'Saved!' : 'Save Settings'}
        </button>
    </div>

    <div class="info">
        <p>
            <strong>Non-custodial:</strong> PromptPay QR uses the sender's saved PromptPay number.
            PSP checkout requires a contracted adapter behind operator control.
        </p>
    </div>
</div>

<style>
    .thailand-settings {
        padding: 1rem;
        max-width: 600px;
    }

    .header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 1.5rem;
    }

    .header h3 {
        margin: 0;
        font-size: 1.125rem;
        font-weight: 600;
    }

    .badge {
        background: #2e5c8a;
        color: #fff;
        padding: 0.125rem 0.5rem;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 700;
    }

    .section {
        margin-bottom: 1.5rem;
        padding-bottom: 1.5rem;
        border-bottom: 1px solid #333;
    }

    .section:last-of-type {
        border-bottom: none;
    }

    .section h4 {
        margin: 0 0 1rem;
        font-size: 0.875rem;
        font-weight: 600;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .field {
        margin-bottom: 1rem;
    }

    .field label {
        display: block;
        margin-bottom: 0.375rem;
        font-size: 0.875rem;
        font-weight: 500;
    }

    .field input {
        width: 100%;
        padding: 0.5rem 0.75rem;
        border: 1px solid #444;
        border-radius: 6px;
        background: #1a1a1a;
        color: #e5e5e5;
        font-size: 0.875rem;
        box-sizing: border-box;
    }

    .field input:focus {
        outline: none;
        border-color: #2e5c8a;
    }

    .field input::placeholder {
        color: #666;
    }

    .hint {
        display: block;
        margin-top: 0.25rem;
        font-size: 0.75rem;
        color: #666;
    }

    .actions {
        margin-top: 1rem;
    }

    .save-btn {
        padding: 0.625rem 1.25rem;
        border: none;
        border-radius: 6px;
        background: #2e5c8a;
        color: #fff;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
    }

    .save-btn:hover {
        background: #1e3c6a;
    }

    .info {
        margin-top: 1.5rem;
        padding: 0.75rem;
        background: #1a1a1a;
        border-radius: 6px;
        border: 1px solid #333;
    }

    .info p {
        margin: 0;
        font-size: 0.75rem;
        color: #888;
        line-height: 1.5;
    }

    .info strong {
        color: #e5e5e5;
    }
</style>