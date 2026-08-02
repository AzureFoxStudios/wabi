<script lang="ts">
  let { onclose }: { onclose?: () => void } = $props()

  let host = $state('')
  let port = $state(8069)
  let database = $state('')
  let username = $state('')
  let apiKey = $state('')
  let ssl = $state(false)
  let testing = $state(false)
  let connected = $state(false)
  let error = $state('')

  $effect(() => {
    loadConfig()
  })

  async function loadConfig() {
    try {
      const res = await fetch('/api/plugins/runtime/verified-operations-odoo/status')
      if (res.ok) {
        const status = await res.json()
        connected = status.connected
      }
    } catch {}
  }

  async function testConnection() {
    testing = true
    error = ''
    try {
      const res = await fetch('/api/plugins/runtime/verified-operations-odoo/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port, database, username, apiKey, ssl }),
      })
      const data = await res.json()
      if (data.success) {
        connected = true
        onclose?.()
      } else {
        error = data.error
      }
    } catch (e) {
      error = String(e)
    }
    testing = false
  }

  async function disconnect() {
    await fetch('/api/plugins/runtime/verified-operations-odoo/disconnect', { method: 'POST' })
    connected = false
  }
</script>

<div class="config">
  <h2 class="mono-sub" style="color:#fff; font-size:14px; margin-bottom:20px">ODOO CONNECTION</h2>

  <div class="field">
    <label class="mono-sub dim">HOST</label>
    <input class="input" type="text" bind:value={host} placeholder="odoo.example.com" />
  </div>

  <div class="field">
    <label class="mono-sub dim">PORT</label>
    <input class="input" type="number" bind:value={port} />
  </div>

  <div class="field">
    <label class="mono-sub dim">DATABASE</label>
    <input class="input" type="text" bind:value={database} placeholder="odoo_db" />
  </div>

  <div class="field">
    <label class="mono-sub dim">USERNAME</label>
    <input class="input" type="text" bind:value={username} placeholder="admin" />
  </div>

  <div class="field">
    <label class="mono-sub dim">API KEY</label>
    <input class="input" type="password" bind:value={apiKey} />
  </div>

  <div class="field checkbox">
    <input type="checkbox" bind:checked={ssl} id="ssl" />
    <label class="mono-sub dim" for="ssl">USE SSL (HTTPS)</label>
  </div>

  {#if error}
    <div class="mono-sub" style="color:#d71921; margin-top:12px">{error}</div>
  {/if}

  <div class="actions">
    {#if connected}
      <button class="btn danger" onclick={disconnect}>DISCONNECT</button>
      <span class="mono-sub" style="color:#4a9e5c">● CONNECTED</span>
    {:else}
      <button class="btn primary" onclick={testConnection} disabled={testing}>
        {testing ? 'CONNECTING...' : 'CONNECT'}
      </button>
    {/if}
  </div>
</div>

<style>
  .config { display: flex; flex-direction: column; }
  .field { margin-bottom: 14px; }
  .field label { display: block; margin-bottom: 4px; }
  .input {
    all: unset;
    width: 100%;
    font: 400 13px/1 'Space Mono', monospace;
    letter-spacing: 0.04em;
    color: #e8e8e8;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 10px 12px;
    box-sizing: border-box;
  }
  .input:focus { border-color: #f26522; }
  .checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .checkbox input { accent-color: #f26522; }
  .actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 16px;
  }
  .btn {
    all: unset;
    font: 400 11px/1 'Space Mono', monospace;
    letter-spacing: 0.08em;
    padding: 10px 20px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .btn.primary {
    background: #f26522;
    color: #000;
  }
  .btn.primary:hover { background: #d95b1f; }
  .btn.primary:disabled { opacity: 0.5; cursor: default; }
  .btn.danger {
    border: 1px solid #d71921;
    color: #d71921;
  }
  .btn.danger:hover { background: #d7192122; }
</style>
