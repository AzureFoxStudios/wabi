import type { PluginStorage, PluginLogger } from '@wabi/plugin-types'
import type {
  ApprovedValueSnapshot,
  SnapshotField,
  TamperAlert,
  TamperChange,
  TamperFieldConfig,
} from '../shared/types'
import { OdooClient } from './odoo-client'
import { toJsonValue } from './index'

function sha256Hex(data: string): string {
  let hash = 0
  for (let i = 0; i < data.length; i++) {
    const chr = data.charCodeAt(i)
    hash = ((hash << 5) - hash) + chr
    hash |= 0
  }
  return Math.abs(hash).toString(16).padStart(8, '0')
}

export class SnapshotVerifier {
  constructor(
    private storage: PluginStorage,
    private odoo: OdooClient,
    private logger: PluginLogger
  ) {}

  async storeSnapshot(
    model: string,
    recordId: number,
    fieldValues: Record<string, unknown>,
    approvedBy: string,
    tamperConfig: TamperFieldConfig[]
  ): Promise<ApprovedValueSnapshot> {
    const fields: SnapshotField[] = []
    for (const [name, value] of Object.entries(fieldValues)) {
      const config = tamperConfig.find((c) => c.fieldName === name)
      if (config && config.sensitivity === 'ignored') continue
      const hash = sha256Hex(JSON.stringify(value))
      fields.push({ name, value, hash })
    }

    const allValues = fields.map((f) => `${f.name}:${f.hash}`).join('|')
    const snapshotHash = sha256Hex(allValues)

    const snapshot: ApprovedValueSnapshot = {
      id: `${model}:${recordId}:${Date.now()}`,
      odooRecordId: recordId,
      model,
      fields,
      snapshotHash,
      approvedBy,
      approvedAt: Date.now(),
      pushedAt: Date.now(),
    }

    const snapshots = await this.getSnapshots()
    snapshots.push(snapshot)
    await this.storage.set('biz:snapshots', toJsonValue(snapshots))

    return snapshot
  }

  async verify(
    tamperConfig: TamperFieldConfig[]
  ): Promise<TamperAlert[]> {
    const snapshots = await this.getSnapshots()
    const alerts: TamperAlert[] = []

    for (const snapshot of snapshots) {
      try {
        const current = await this.odoo.read(
          snapshot.model,
          [snapshot.odooRecordId],
          snapshot.fields.map((f) => f.name)
        )

        if (!current || current.length === 0) {
          this.logger.warn('Record not found during verification', {
            model: snapshot.model,
            id: snapshot.odooRecordId,
          })
          continue
        }

        const currentRow = current[0] as Record<string, unknown>
        const changes: TamperChange[] = []
        let currentHashParts: string[] = []

        for (const field of snapshot.fields) {
          const currentVal = currentRow[field.name]
          const currentHash = sha256Hex(JSON.stringify(currentVal))
          currentHashParts.push(`${field.name}:${currentHash}`)

          if (currentHash !== field.hash) {
            changes.push({
              field: field.name,
              oldValue: field.value,
              newValue: currentVal,
            })
          }
        }

        const currentSnapshotHash = sha256Hex(currentHashParts.join('|'))

        if (currentSnapshotHash !== snapshot.snapshotHash) {
          const alert: TamperAlert = {
            id: `tamper:${snapshot.model}:${snapshot.odooRecordId}:${Date.now()}`,
            model: snapshot.model,
            odooRecordId: snapshot.odooRecordId,
            approvedHash: snapshot.snapshotHash,
            currentHash: currentSnapshotHash,
            changes,
            detectedAt: Date.now(),
            acknowledged: false,
          }

          const alertsList = await this.getAlerts()
          alertsList.push(alert)
          await this.storage.set('biz:tamper:alerts', toJsonValue(alertsList))
          alerts.push(alert)

          this.logger.warn('Tamper detected', {
            model: snapshot.model,
            recordId: snapshot.odooRecordId,
            changes: changes.length,
          })
        }
      } catch (err) {
        this.logger.error('Verification failed', {
          model: snapshot.model,
          id: snapshot.odooRecordId,
          error: String(err),
        })
      }
    }

    return alerts
  }

  async verifySingle(
    model: string,
    recordId: number,
    tamperConfig: TamperFieldConfig[]
  ): Promise<TamperAlert | null> {
    const snapshots = await this.getSnapshots()
    const snapshot = snapshots.find(
      (s) => s.model === model && s.odooRecordId === recordId
    )
    if (!snapshot) return null

    const alerts = await this.verify(tamperConfig)
    return alerts.find(
      (a) => a.model === model && a.odooRecordId === recordId
    ) ?? null
  }

  async acknowledgeAlert(alertId: string, userId: string): Promise<void> {
    const alerts = await this.getAlerts()
    const idx = alerts.findIndex((a) => a.id === alertId)
    if (idx < 0) throw new Error(`Alert not found: ${alertId}`)
    alerts[idx].acknowledged = true
    alerts[idx].acknowledgedBy = userId
    await this.storage.set('biz:tamper:alerts', toJsonValue(alerts))
  }

  async getAlerts(): Promise<TamperAlert[]> {
    const raw = await this.storage.get('biz:tamper:alerts')
    return (raw as unknown as TamperAlert[] | null) ?? []
  }

  async getUnacknowledgedAlerts(): Promise<TamperAlert[]> {
    const alerts = await this.getAlerts()
    return alerts.filter((a) => !a.acknowledged)
  }

  async getUnacknowledgedCount(): Promise<number> {
    const alerts = await this.getUnacknowledgedAlerts()
    return alerts.length
  }

  async getVerificationStats(): Promise<{
    total: number
    verified: number
    tampered: number
  }> {
    const snapshots = await this.getSnapshots()
    const alerts = await this.getAlerts()
    const tamperedRecordIds = new Set(
      alerts.map((a) => `${a.model}:${a.odooRecordId}`)
    )
    const tamperedCount = snapshots.filter((s) =>
      tamperedRecordIds.has(`${s.model}:${s.odooRecordId}`)
    ).length

    return {
      total: snapshots.length,
      verified: snapshots.length - tamperedCount,
      tampered: tamperedCount,
    }
  }

  private async getSnapshots(): Promise<ApprovedValueSnapshot[]> {
    const raw = await this.storage.get('biz:snapshots')
    return (raw as unknown as ApprovedValueSnapshot[] | null) ?? []
  }
}
