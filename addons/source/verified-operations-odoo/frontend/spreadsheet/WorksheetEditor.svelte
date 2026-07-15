<script lang="ts">
  import Tag from '../dashboard/shared/Tag.svelte'

  interface TemplateField {
    key: string
    label: string
    type: string
    required: boolean
    options?: string[]
    minRole: string
  }

  interface WorksheetTemplate {
    id: string
    name: string
    description: string
    fieldMappings: TemplateField[]
  }

  let { draftId, onsave }: { draftId?: string; onsave?: () => void } = $props()

  let templates = $state<WorksheetTemplate[]>([])
  let selectedTemplate = $state('')
  let currentTemplate = $state<WorksheetTemplate | null>(null)
  let values = $state<Record<string, unknown>>({})
  let saving = $state(false)

  $effect(() => { loadTemplates() })

  async function loadTemplates() {
    const res = await fetch('/api/plugins/runtime/verified-operations-odoo/templates')
    if (res.ok) templates = await res.json()
  }

  function selectTemplate(id: string) {
    selectedTemplate = id
    currentTemplate = templates.find((t) => t.id === id) ?? null
    values = {}
    for (const field of currentTemplate?.fieldMappings ?? []) {
      values[field.key] = field.defaultValue ?? ''
    }
  }

  async function saveDraft() {
    if (!currentTemplate) return
    saving = true
    const payload = {
      id: draftId,
      templateId: currentTemplate.id,
      name: currentTemplate.name,
      status: 'draft',
      data: values,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await fetch('/api/plugins/runtime/verified-operations-odoo/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    saving = false
    onsave?.()
  }
</script>

<div class="editor">
  {#if !currentTemplate}
    <div class="template-select">
      <h2 class="mono-sub" style="color:#fff; font-size:14px; margin-bottom:16px">NEW WORKSHEET</h2>
      {#each templates as tpl}
        <div class="tpl-row" onclick={() => selectTemplate(tpl.id)}>
          <div>
            <div class="mono-sub" style="color:#e8e8e8">{tpl.name}</div>
            <div class="mono-sub dim">{tpl.description}</div>
          </div>
          <span class="mono-sub" style="color:#f26522">→</span>
        </div>
      {/each}
    </div>
  {:else}
    <div class="form">
      <div class="form-header">
        <h2 class="mono-sub" style="color:#fff; font-size:14px">{currentTemplate.name}</h2>
        <button class="btn-back mono-sub" onclick={() => currentTemplate = null}>← BACK</button>
      </div>
      <div class="fields">
        {#each currentTemplate.fieldMappings as field}
          <div class="field-row">
            <label class="mono-sub dim">
              {field.label}
              {#if field.required}<span style="color:#d71921">*</span>{/if}
            </label>
            {#if field.type === 'select'}
              <select class="input" bind:value={values[field.key]}>
                <option value="">--</option>
                {#each field.options ?? [] as opt}
                  <option value={opt}>{opt}</option>
                {/each}
              </select>
            {:else if field.type === 'number' || field.type === 'currency'}
              <input class="input" type="number" bind:value={values[field.key]} />
            {:else if field.type === 'photo'}
              <input class="input" type="file" accept="image/*" />
            {:else}
              <input class="input" type="text" bind:value={values[field.key]}
                placeholder={field.label} />
            {/if}
          </div>
        {/each}
      </div>
      <button class="btn-save" onclick={saveDraft} disabled={saving}>
        {saving ? 'SAVING...' : 'SAVE DRAFT'}
      </button>
    </div>
  {/if}
</div>

<style>
  .editor { display: flex; flex-direction: column; }
  .template-select { display: flex; flex-direction: column; }
  .tpl-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px;
    border: 1px solid #222;
    border-radius: 8px;
    margin-bottom: 8px;
    cursor: pointer;
    transition: border-color 0.2s;
  }
  .tpl-row:hover { border-color: #f26522; }
  .form { display: flex; flex-direction: column; }
  .form-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }
  .btn-back {
    all: unset;
    cursor: pointer;
    color: #f26522;
    padding: 6px 12px;
    border: 1px solid #333;
    border-radius: 6px;
  }
  .btn-back:hover { border-color: #f26522; }
  .fields { display: flex; flex-direction: column; gap: 14px; }
  .field-row { display: flex; flex-direction: column; gap: 4px; }
  .input {
    all: unset;
    font: 400 13px/1 'Space Mono', monospace;
    letter-spacing: 0.04em;
    color: #e8e8e8;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 10px 12px;
    width: 100%;
    box-sizing: border-box;
  }
  .input:focus { border-color: #f26522; }
  select.input { cursor: pointer; }
  .btn-save {
    all: unset;
    font: 400 11px/1 'Space Mono', monospace;
    letter-spacing: 0.08em;
    background: #f26522;
    color: #000;
    padding: 12px 24px;
    border-radius: 8px;
    cursor: pointer;
    text-align: center;
    margin-top: 20px;
    transition: background 0.2s;
  }
  .btn-save:hover { background: #d95b1f; }
  .btn-save:disabled { opacity: 0.5; cursor: default; }
</style>
