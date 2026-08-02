import type { PluginStorage } from '@wabi/plugin-types'
import type { AuditEvent } from '../shared/types'
import { toJsonValue } from './index'

export class AuditLogger {
  private enabled = true
  private denseMode = false

  constructor(private storage: PluginStorage) {}

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled
    await this.storage.set('biz:audit:enabled', toJsonValue(enabled))
  }

  async setDenseMode(dense: boolean): Promise<void> {
    this.denseMode = dense
    await this.storage.set('biz:audit:dense', toJsonValue(dense))
  }

  async init(): Promise<void> {
    const enabledRaw = await this.storage.get('biz:audit:enabled')
    const enabled = enabledRaw as unknown as boolean | null
    if (enabled !== null) this.enabled = enabled

    const denseRaw = await this.storage.get('biz:audit:dense')
    const dense = denseRaw as unknown as boolean | null
    if (dense !== null) this.denseMode = dense
  }

  async log(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void> {
    if (!this.enabled) return

    const auditEvent: AuditEvent = {
      ...event,
      id: `audit:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    }
    const events = await this.getAll()
    events.push(auditEvent)
    await this.storage.set('biz:audit:events', toJsonValue(events))
  }

  async logView(
    actorId: string,
    actorRole: string,
    sheetId: string
  ): Promise<void> {
    if (!this.denseMode) return
    await this.log({
      action: 'sheet:viewed',
      actorId,
      actorRole,
      details: { sheetId },
    })
  }

  async logEdit(
    actorId: string,
    actorRole: string,
    model: string,
    recordId: number | undefined,
    field: string,
    oldValue: unknown,
    newValue: unknown
  ): Promise<void> {
    await this.log({
      action: 'field:edited',
      actorId,
      actorRole,
      model,
      recordId,
      details: { field, oldValue, newValue },
    })
  }

  async logApproval(
    actorId: string,
    actorRole: string,
    draftId: string,
    decision: 'approved' | 'rejected',
    reason?: string
  ): Promise<void> {
    await this.log({
      action: `approval:${decision}`,
      actorId,
      actorRole,
      details: { draftId, reason },
    })
  }

  async logPush(
    actorId: string,
    actorRole: string,
    model: string,
    recordId: number,
    draftId: string
  ): Promise<void> {
    await this.log({
      action: 'odoo:pushed',
      actorId,
      actorRole,
      model,
      recordId,
      details: { draftId },
    })
  }

  async logTamper(
    actorId: string,
    actorRole: string,
    model: string,
    recordId: number
  ): Promise<void> {
    await this.log({
      action: 'tamper:detected',
      actorId,
      actorRole,
      model,
      recordId,
      details: { acknowledged: true },
    })
  }

  async getAll(): Promise<AuditEvent[]> {
    const raw = await this.storage.get('biz:audit:events')
    return (raw as unknown as AuditEvent[] | null) ?? []
  }

  async query(filters: {
    action?: string
    actorId?: string
    model?: string
    since?: number
    limit?: number
  }): Promise<AuditEvent[]> {
    let events = await this.getAll()

    if (filters.action) {
      events = events.filter((e) => e.action === filters.action)
    }
    if (filters.actorId) {
      events = events.filter((e) => e.actorId === filters.actorId)
    }
    if (filters.model) {
      events = events.filter((e) => e.model === filters.model)
    }
    if (filters.since) {
      events = events.filter((e) => e.timestamp >= filters.since!)
    }

    events.sort((a, b) => b.timestamp - a.timestamp)
    return events.slice(0, filters.limit ?? 100)
  }
}
