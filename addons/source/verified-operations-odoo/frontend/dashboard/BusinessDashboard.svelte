<script lang="ts">
  import Tag from './shared/Tag.svelte'
  import Led from './shared/Led.svelte'
  import Segbar from './shared/Segbar.svelte'
  import ApprovalQueueCard from './ApprovalQueueCard.svelte'
  import TamperMonitorCard from './TamperMonitorCard.svelte'
  import StatusFeed from './StatusFeed.svelte'
  import OdooConnectionConfig from '../admin/OdooConnectionConfig.svelte'

  let status = $state<{
    connected: boolean
    draftCount: number
    pendingApprovals: number
    tamperAlerts: number
  } | null>(null)

  let connectionOpen = $state(false)

  $effect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 30000)
    return () => clearInterval(interval)
  })

  async function fetchStatus() {
    try {
      const res = await fetch('/api/plugins/runtime/verified-operations-odoo/status')
      if (res.ok) status = await res.json()
    } catch {}
  }
</script>

<div class="dashboard">
  <div class="bento">
    <div class="card hero">
      <Tag text="DASHBOARD" always={true} />
      <div class="clock-line">
        <span class="clock">{new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</span>
        <span class="clock-sec">{new Date().toLocaleTimeString('th-TH', { second: '2-digit' })}</span>
      </div>
      <div class="hero-foot">
        <div>
          <div class="day">{new Date().toLocaleDateString('th-TH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
          <div class="mono-sub dim" style="margin-top:4px">
            {#if status}
              {status.connected ? 'Odoo ● Connected' : 'Odoo ○ Disconnected'}
            {:else}
              Loading...
            {/if}
          </div>
        </div>
        <div class="status">
          {#if status?.connected}
            <div class="mono-sub" style="color:#4a9e5c">
              <Led color="green" size={7} />
              SYSTEM ONLINE
            </div>
            <div class="mono-sub dim" style="margin-top:4px">
              {status.draftCount} drafts · {status.pendingApprovals} pending · {status.tamperAlerts} alerts
            </div>
          {:else}
            <div class="mono-sub" style="color:#f26522">
              <Led size={7} />
              NOT CONNECTED
            </div>
            <button class="connect-btn" onclick={() => connectionOpen = true}>
              CONFIGURE ODOO
            </button>
          {/if}
        </div>
      </div>
    </div>

    <div class="card">
      <Tag text="INVOICES" />
      <div class="doto-val">24<small>open</small></div>
      <div class="mono-sub dim">▲ 3 since yesterday</div>
      <Segbar segments={8} active={6} color="orange" />
    </div>

    <div class="card">
      <Tag text="PURCHASE" />
      <div class="metric">8<small>pending</small></div>
      <div class="mono-sub dim">2 require approval</div>
      <Segbar segments={8} active={3} color="orange" />
    </div>

    <div class="card contrib">
      <Tag text="APPROVALS" />
      <ApprovalQueueCard />
    </div>

    <div class="card seismo">
      <Tag text="TAMPER MONITOR" />
      <TamperMonitorCard />
    </div>

    <div class="card feed">
      <Tag text="ACTIVITY" />
      <StatusFeed />
    </div>
  </div>
</div>

{#if connectionOpen}
  <div class="overlay" onclick={() => connectionOpen = false}>
    <div class="panel" onclick={(e) => e.stopPropagation()}>
      <OdooConnectionConfig onclose={() => { connectionOpen = false; fetchStatus() }} />
    </div>
  </div>
{/if}

<style>
  .dashboard {
    width: 100%;
    padding: 20px;
    background: #000;
    min-height: 100vh;
  }
  .bento {
    display: grid;
    grid-template-rows: 200px 200px 185px 185px;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    width: 100%;
    max-width: 1120px;
    margin: 0 auto;
  }
  .card {
    background: #111;
    border: 1px solid #222;
    border-radius: 16px;
    padding: 24px;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
    transition: border-color 0.2s ease-out;
  }
  .card:hover {
    border-color: #333;
  }
  .hero {
    grid-area: 1 / 1 / 3 / 3;
    justify-content: space-between;
    background-image: radial-gradient(circle, #1d1d1d 1.1px, transparent 1.1px);
    background-position: 8px 8px;
    background-size: 16px 16px;
  }
  .clock-line {
    display: flex;
    align-items: center;
    gap: 20px;
    justify-content: center;
  }
  .clock {
    font-family: 'Doto', sans-serif;
    font-size: 108px;
    font-weight: 400;
    line-height: 1;
    color: #fff;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
  }
  .clock-sec {
    font-family: 'Doto', sans-serif;
    font-size: 34px;
    font-weight: 400;
    color: #999;
    align-self: flex-end;
    padding-bottom: 12px;
    font-variant-numeric: tabular-nums;
  }
  .hero-foot {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 24px;
  }
  .day {
    font: 500 26px/1.2 'Space Grotesk', sans-serif;
    color: #fff;
    letter-spacing: -0.01em;
  }
  .status {
    max-width: 240px;
    min-height: 36px;
  }
  .doto-val {
    font-family: 'Doto', sans-serif;
    font-size: 58px;
    font-weight: 400;
    line-height: 1;
    color: #fff;
    margin-top: 10px;
  }
  .doto-val small {
    font-size: 20px;
    font-weight: 400;
    color: #999;
    margin-left: 3px;
    vertical-align: super;
  }
  .metric {
    font: 700 36px/1 'Space Mono', monospace;
    color: #fff;
    letter-spacing: -0.02em;
    margin-top: 14px;
  }
  .metric small {
    font-size: 13px;
    font-weight: 400;
    color: #999;
    margin-left: 5px;
    letter-spacing: 0.04em;
  }
  .mono-sub {
    font: 400 11px/1.6 'Space Mono', monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #999;
  }
  .dim { color: #666; }
  .contrib { grid-column: 2 / 4; }
  .seismo { grid-column: 1 / 3; }
  .feed { grid-column: 3 / 5; }
  .connect-btn {
    background: none;
    border: 1px solid #333;
    color: #e8e8e8;
    font: 400 10px/1 'Space Mono', monospace;
    letter-spacing: 0.08em;
    padding: 8px 14px;
    border-radius: 8px;
    cursor: pointer;
    margin-top: 8px;
    transition: border-color 0.2s;
  }
  .connect-btn:hover {
    border-color: #f26522;
  }
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.65);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 16vh;
    z-index: 50;
  }
  .panel {
    background: #111;
    border: 1px solid #333;
    border-radius: 12px;
    width: min(540px, 92vw);
    padding: 24px;
  }

  @media (width <= 940px) {
    .bento {
      grid-template-rows: none;
      grid-template-columns: repeat(2, 1fr);
      grid-auto-rows: 190px;
      grid-auto-flow: dense;
    }
    .hero { grid-area: span 2 / 1 / auto / 3; }
    .contrib, .seismo, .feed { grid-column: 1 / 3; }
    .clock { font-size: 96px; }
  }
  @media (width <= 520px) {
    .dashboard { padding: 14px; }
    .bento { grid-auto-rows: 180px; gap: 8px; }
    .card { border-radius: 14px; padding: 18px; }
    .clock { font-size: 78px; }
    .clock-sec { padding-bottom: 8px; font-size: 26px; }
    .day { font-size: 20px; }
    .status { max-width: 170px; }
    .doto-val { font-size: 48px; }
    .metric { font-size: 30px; }
  }
</style>
