import type { PluginStorage } from '@wabi/plugin-types'
import type { DraftWorksheet, WorksheetTemplate, WorksheetAttachment } from '../shared/types'
import { toJsonValue } from './index'

export class DraftManager {
  constructor(private storage: PluginStorage) {}

  async create(draft: DraftWorksheet): Promise<void> {
    const drafts = await this.list()
    drafts.push(draft)
    await this.storage.set('biz:drafts', toJsonValue(drafts))
  }

  async get(id: string): Promise<DraftWorksheet | null> {
    const drafts = await this.list()
    return drafts.find((d) => d.id === id) ?? null
  }

  async list(filters?: {
    status?: string
    channelId?: string
    createdBy?: string
  }): Promise<DraftWorksheet[]> {
    const raw = await this.storage.get('biz:drafts')
    const drafts = (raw as unknown as DraftWorksheet[] | null) ?? []
    if (!drafts) return []

    let filtered = drafts
    if (filters?.status) {
      filtered = filtered.filter((d: DraftWorksheet) => d.status === filters.status)
    }
    if (filters?.channelId) {
      filtered = filtered.filter((d: DraftWorksheet) => d.channelId === filters.channelId)
    }
    if (filters?.createdBy) {
      filtered = filtered.filter((d: DraftWorksheet) => d.createdBy === filters.createdBy)
    }
    return filtered.sort((a: DraftWorksheet, b: DraftWorksheet) => b.updatedAt - a.updatedAt)
  }

  async update(id: string, updates: Partial<DraftWorksheet>): Promise<void> {
    const drafts = await this.list()
    const idx = drafts.findIndex((d) => d.id === id)
    if (idx < 0) throw new Error(`Draft not found: ${id}`)
    drafts[idx] = { ...drafts[idx], ...updates, updatedAt: Date.now() }
    await this.storage.set('biz:drafts', toJsonValue(drafts))
  }

  async delete(id: string): Promise<void> {
    const drafts = await this.list()
    await this.storage.set(
      'biz:drafts',
      toJsonValue(drafts.filter((d) => d.id !== id))
    )
  }

  async addAttachment(
    draftId: string,
    attachment: WorksheetAttachment
  ): Promise<void> {
    const draft = await this.get(draftId)
    if (!draft) throw new Error(`Draft not found: ${draftId}`)
    draft.attachments.push(attachment)
    await this.update(draftId, { attachments: draft.attachments })
  }

  async getTemplates(): Promise<WorksheetTemplate[]> {
    const raw = await this.storage.get('biz:templates')
    const templates = (raw as unknown as WorksheetTemplate[] | null) ?? []
    if (!templates || templates.length === 0) {
      return [this.defaultPurchaseTemplate(), this.defaultEstimateTemplate()]
    }
    return templates
  }

  async saveTemplate(template: WorksheetTemplate): Promise<void> {
    const templates = await this.getTemplates()
    const idx = templates.findIndex((t) => t.id === template.id)
    if (idx >= 0) {
      templates[idx] = template
    } else {
      templates.push(template)
    }
    await this.storage.set('biz:templates', toJsonValue(templates))
  }

  private defaultPurchaseTemplate(): WorksheetTemplate {
    return {
      id: 'purchase-request',
      name: 'Purchase Request',
      description: 'Standard purchase order request with approval chain',
      odooModel: 'purchase.order',
      category: 'purchasing',
      fieldMappings: [
        { key: 'vendor', label: 'Vendor', type: 'text', required: true, minRole: 'contributor', odooField: 'partner_id' },
        { key: 'product', label: 'Item', type: 'text', required: true, minRole: 'contributor' },
        { key: 'quantity', label: 'Quantity', type: 'number', required: true, minRole: 'contributor', odooField: 'product_qty' },
        { key: 'unit_price', label: 'Unit Price', type: 'currency', required: true, minRole: 'purchasing', odooField: 'price_unit' },
        { key: 'total', label: 'Total', type: 'currency', required: true, minRole: 'viewer' },
        { key: 'notes', label: 'Notes', type: 'text', required: false, minRole: 'contributor' },
        { key: 'photo_receipt', label: 'Receipt Photo', type: 'photo', required: false, minRole: 'contributor' },
      ],
    }
  }

  private defaultEstimateTemplate(): WorksheetTemplate {
    return {
      id: 'job-estimate',
      name: 'Job Estimate',
      description: 'Field estimate worksheet with measurement and material planning',
      odooModel: 'sale.order',
      category: 'estimates',
      fieldMappings: [
        { key: 'customer', label: 'Customer', type: 'text', required: true, minRole: 'contributor', odooField: 'partner_id' },
        { key: 'area', label: 'Area (sqm)', type: 'number', required: true, minRole: 'estimator' },
        { key: 'material_type', label: 'Material Type', type: 'select', required: true, minRole: 'estimator', options: ['Tile', 'Metal', 'Shingle', 'Flat'] },
        { key: 'labor_cost', label: 'Labor Cost', type: 'currency', required: true, minRole: 'estimator' },
        { key: 'material_cost', label: 'Material Cost', type: 'currency', required: true, minRole: 'estimator' },
        { key: 'travel_cost', label: 'Travel Cost', type: 'currency', required: false, minRole: 'estimator' },
        { key: 'waste_pct', label: 'Waste %', type: 'number', required: false, minRole: 'estimator' },
        { key: 'site_notes', label: 'Site Notes', type: 'text', required: false, minRole: 'contributor' },
        { key: 'site_photos', label: 'Site Photos', type: 'photo', required: false, minRole: 'contributor' },
      ],
    }
  }
}
