import { formatSatsLabel } from './bitcoin-qr';

const DEFAULT_EXPIRES_MS = 15 * 60 * 1000;

function getPublicBaseUrl(): string {
	const raw =
		process.env.WABI_PUBLIC_BASE_URL ||
		process.env.PUBLIC_URL ||
		`http://127.0.0.1:${process.env.PORT || '3000'}`;
	return raw.replace(/\/+$/, '');
}

function envFlag(value?: string): boolean {
	const normalized = String(value || '').trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function isTestModeEnabled(): boolean {
	return envFlag(process.env.BTC_PAYMENTS_TEST_MODE);
}

export function buildLocalTestLightningUrl(providerIntentId: string): string {
	return `${getPublicBaseUrl()}/api/plugins/runtime/payments-bitcoin/lightning-test?providerIntentId=${encodeURIComponent(providerIntentId)}`;
}

export interface LightningRecord {
	providerIntentId: string;
	amountMinor: number;
	status: string;
}

export function createLocalTestLightningHtml(record: LightningRecord): string {
	const providerIntentId = String(record.providerIntentId || '');
	const amountLabel = formatSatsLabel(record.amountMinor);
	const currentStatus = String(record.status || 'pending');
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bitcoin Lightning Local Test</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      font-family: "Segoe UI", Arial, sans-serif;
      background: linear-gradient(145deg, #120d05 0%, #211508 100%);
      color: #fff6e5;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(520px, 100%);
      background: rgba(24, 16, 7, 0.94);
      border: 1px solid rgba(255, 166, 51, 0.26);
      border-radius: 20px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      padding: 24px;
    }
    h1 { margin: 0 0 8px; font-size: 1.35rem; }
    p { margin: 0 0 12px; color: #efc78d; line-height: 1.5; }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 10px 14px;
      margin: 20px 0;
    }
    dt { color: #e4aa5d; }
    dd { margin: 0; }
    .status {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 6px 12px;
      background: rgba(255, 166, 51, 0.18);
      border: 1px solid rgba(255, 166, 51, 0.28);
      color: #ffe0b4;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 0.75rem;
    }
    .actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 18px;
    }
    button {
      border: 0;
      border-radius: 12px;
      padding: 12px 14px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      background: #ff8b2d;
      color: #15110b;
    }
    button.secondary { background: #5a4938; color: #fff2df; }
    .hint {
      margin-top: 16px;
      font-size: 0.9rem;
      color: #efc78d;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Lightning Local Test</h1>
    <p>This is localhost-only Lightning simulation. It does not create a real invoice and does not move money.</p>
    <dl>
      <dt>Intent</dt><dd><code>${providerIntentId}</code></dd>
      <dt>Amount</dt><dd>${amountLabel}</dd>
      <dt>Status</dt><dd><span class="status">${currentStatus}</span></dd>
    </dl>
    <div class="actions">
      <button type="button" onclick="setStatus('succeeded')">Simulate Paid</button>
      <button type="button" class="secondary" onclick="setStatus('failed')">Simulate Failure</button>
      <button type="button" class="secondary" onclick="setStatus('canceled')">Simulate Cancel</button>
      <button type="button" class="secondary" onclick="setStatus('pending')">Reset Pending</button>
    </div>
    <p class="hint">After changing status here, go back to Wabi and refresh the request.</p>
  </main>
  <script>
    async function setStatus(status) {
      const response = await fetch(window.location.pathname + window.location.search, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerIntentId: '${providerIntentId}', action: status })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        alert(payload.error || 'Failed to update local test Lightning intent');
        return;
      }
      window.location.reload();
    }
  </script>
</body>
</html>`;
}

export function getDefaultExpiresAt(): number {
	return Date.now() + DEFAULT_EXPIRES_MS;
}