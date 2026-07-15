import type { PluginStorage } from '@wabi/plugin-types'
import { OdooClient } from './odoo-client'
import { toJsonValue } from './index'

export interface Conflict {
  field: string
  wabiValue: unknown
  odooValue: unknown
  odooUser?: string
  odooTimestamp?: number
  resolved: boolean
  resolution?: 'accept-wabi' | 'accept-odoo'
}

export interface ConflictRecord {
  id: string
  model: string
  recordId: number
  sheetId: string
  conflicts: Conflict[]
  detectedAt: number
  resolvedAt?: number
  resolvedBy?: string
}

export class ConflictDetector {
  constructor(
    private storage: PluginStorage,
    private odoo: OdooClient
  ) {}

  async detect(
    model: string,
    recordId: number,
    proposedValues: Record<string, unknown>,
    sheetId: string
  ): Promise<Conflict[]> {
    try {
      const current = await this.odoo.read(model, [recordId], Object.keys(proposedValues))
      if (!current || current.length === 0) {
        return []
      }

      const currentRow = current[0] as Record<string, unknown>
      const conflicts: Conflict[] = []

      for (const [field, proposedValue] of Object.entries(proposedValues)) {
        const currentValue = currentRow[field]
        if (JSON.stringify(currentValue) !== JSON.stringify(proposedValue)) {
          conflicts.push({
            field,
            wabiValue: proposedValue,
            odooValue: currentValue,
            resolved: false,
          })
        }
      }

      if (conflicts.length > 0) {
        const record: ConflictRecord = {
          id: `${model}:${recordId}:${Date.now()}`,
          model,
          recordId,
          sheetId,
          conflicts,
          detectedAt: Date.now(),
        }

        const records = await this.list()
        records.push(record)
        await this.storage.set('biz:conflicts', toJsonValue(records))
      }

      return conflicts
    } catch {
      return []
    }
  }

  async resolve(
    conflictId: string,
    resolution: 'accept-wabi' | 'accept-odoo',
    resolvedBy: string
  ): Promise<void> {
    const records = await this.list()
    const idx = records.findIndex((r) => r.id === conflictId)
    if (idx < 0) throw new Error(`Conflict not found: ${conflictId}`)

    for (const conflict of records[idx].conflicts) {
      if (!conflict.resolved) {
        conflict.resolved = true
        conflict.resolution = resolution
      }
    }

    records[idx].resolvedAt = Date.now()
    records[idx].resolvedBy = resolvedBy
    await this.storage.set('biz:conflicts', toJsonValue(records))
  }

  async list(): Promise<ConflictRecord[]> {
    const raw = await this.storage.get('biz:conflicts')
    return (raw as unknown as ConflictRecord[] | null) ?? []
  }

  async getPendingCount(): Promise<number> {
    const records = await this.list()
    return records.filter((r) => !r.resolvedAt).length
  }
}
