<script lang="ts">
    let stripeEnabled = false;
    let stripeSecretKey = '';
    let stripeWebhookSecret = '';
    let paypalEnabled = false;
    let paypalClientId = '';
    let paypalClientSecret = '';
    let paypalWebhookSecret = '';
    let saved = false;

    function handleSave() {
        saved = true;
        setTimeout(() => {
            saved = false;
        }, 2000);
    }
</script>

<div class="psp-settings">
    <div class="header">
        <h3>PSP Payments</h3>
        <span class="badge">Stripe/PayPal</span>
    </div>

    <div class="section">
        <h4>Stripe</h4>
        <div class="checkbox-field">
            <input
                id="stripeEnabled"
                type="checkbox"
                bind:checked={stripeEnabled}
            />
            <label for="stripeEnabled">Enable Stripe</label>
        </div>
        {#if stripeEnabled}
            <div class="field">
                <label for="stripeSecretKey">Secret Key (sk_...)</label>
                <input
                    id="stripeSecretKey"
                    type="password"
                    bind:value={stripeSecretKey}
                    placeholder="sk_live_..."
                />
                <span class="hint">Starts with sk_live_ for production.</span>
            </div>
            <div class="field">
                <label for="stripeWebhookSecret">Webhook Secret</label>
                <input
                    id="stripeWebhookSecret"
                    type="text"
                    bind:value={stripeWebhookSecret}
                    placeholder="whsec_..."
                />
            </div>
        {/if}
    </div>

    <div class="section">
        <h4>PayPal</h4>
        <div class="checkbox-field">
            <input
                id="paypalEnabled"
                type="checkbox"
                bind:checked={paypalEnabled}
            />
            <label for="paypalEnabled">Enable PayPal</label>
        </div>
        {#if paypalEnabled}
            <div class="field">
                <label for="paypalClientId">Client ID</label>
                <input
                    id="paypalClientId"
                    type="text"
                    bind:value={paypalClientId}
                    placeholder="Client ID from developer portal"
                />
            </div>
            <div class="field">
                <label for="paypalClientSecret">Client Secret</label>
                <input
                    id="paypalClientSecret"
                    type="password"
                    bind:value={paypalClientSecret}
                    placeholder="Client Secret"
                />
            </div>
            <div class="field">
                <label for="paypalWebhookSecret">Webhook ID</label>
                <input
                    id="paypalWebhookSecret"
                    type="text"
                    bind:value={paypalWebhookSecret}
                    placeholder="Webhook ID"
                />
            </div>
        {/if}
    </div>

    <div class="actions">
        <button class="save-btn" on:click={handleSave}>
            {saved ? 'Saved!' : 'Save Settings'}
        </button>
    </div>

    <div class="info">
        <p>
            <strong>Note:</strong> Requires contracted PSP accounts. API keys are stored server-side only.
        </p>
    </div>
</div>

<style>
    .psp-settings {
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
        background: #635bff;
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
        border-color: #635bff;
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

    .checkbox-field {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 1rem;
    }

    .checkbox-field input {
        width: auto;
    }

    .checkbox-field label {
        margin: 0;
        font-size: 0.875rem;
    }

    .actions {
        margin-top: 1rem;
    }

    .save-btn {
        padding: 0.625rem 1.25rem;
        border: none;
        border-radius: 6px;
        background: #635bff;
        color: #fff;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
    }

    .save-btn:hover {
        background: #4f48cc;
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