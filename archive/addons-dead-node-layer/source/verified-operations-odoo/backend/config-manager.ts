import type { PluginStorage } from '@wabi/plugin-types'
import type {
  OdooConnectionConfig,
  SpreadsheetDefinition,
  SpendingCap,
  TamperFieldConfig,
} from '../shared/types'
import { toJsonValue } from './index'

const STORAGE_KEYS = {
  ODOO_CONNECTION: 'biz:odoo:connection',
  SPREADSHEET_DEFS: 'biz:odoo:sheets',
  SPENDING_CAPS: 'biz:spending:caps',
  TAMPER_CONFIG: 'biz:tamper:config',
  REFRESH_INTERVAL: 'biz:refresh:interval',
} as const

export class ConfigManager {
  constructor(private storage: PluginStorage) {}

  async getOdooConnection(): Promise<OdooConnectionConfig | null> {
    const raw = await this.storage.get(STORAGE_KEYS.ODOO_CONNECTION)
    return raw as unknown as OdooConnectionConfig | null
  }

  async saveOdooConnection(config: OdooConnectionConfig): Promise<void> {
    await this.storage.set(STORAGE_KEYS.ODOO_CONNECTION, toJsonValue(config))
  }

  async clearOdooConnection(): Promise<void> {
    await this.storage.delete(STORAGE_KEYS.ODOO_CONNECTION)
  }

  async getSpreadsheetDefs(): Promise<SpreadsheetDefinition[]> {
    const raw = await this.storage.get(STORAGE_KEYS.SPREADSHEET_DEFS)
    return (raw as unknown as SpreadsheetDefinition[] | null) ?? []
  }

  async saveSpreadsheetDef(def: SpreadsheetDefinition): Promise<void> {
    const defs = await this.getSpreadsheetDefs()
    const idx = defs.findIndex((d) => d.id === def.id)
    if (idx >= 0) {
      defs[idx] = def
    } else {
      defs.push(def)
    }
    await this.storage.set(STORAGE_KEYS.SPREADSHEET_DEFS, toJsonValue(defs))
  }

  async deleteSpreadsheetDef(id: string): Promise<void> {
    const defs = await this.getSpreadsheetDefs()
    await this.storage.set(
      STORAGE_KEYS.SPREADSHEET_DEFS,
      toJsonValue(defs.filter((d) => d.id !== id))
    )
  }

  async getSpendingCaps(): Promise<SpendingCap[]> {
    const raw = await this.storage.get(STORAGE_KEYS.SPENDING_CAPS)
    const caps = (raw as unknown as SpendingCap[] | null) ?? []
    if (!caps || caps.length === 0) {
      return [
        { role: 'viewer', maxAmount: 0, currency: 'THB', requiresApproval: true },
        { role: 'contributor', maxAmount: 5000, currency: 'THB', requiresApproval: true, escalationRole: 'mod' },
        { role: 'mod', maxAmount: 50000, currency: 'THB', requiresApproval: true, escalationRole: 'admin' },
        { role: 'admin', maxAmount: 500000, currency: 'THB', requiresApproval: false },
        { role: 'owner', maxAmount: 0, currency: 'THB', requiresApproval: false },
      ]
    }
    return caps
  }

  async saveSpendingCaps(caps: SpendingCap[]): Promise<void> {
    await this.storage.set(STORAGE_KEYS.SPENDING_CAPS, toJsonValue(caps))
  }

  async getTamperConfig(): Promise<TamperFieldConfig[]> {
    const raw = await this.storage.get(STORAGE_KEYS.TAMPER_CONFIG)
    return (raw as unknown as TamperFieldConfig[] | null) ?? []
  }

  async saveTamperConfig(config: TamperFieldConfig[]): Promise<void> {
    await this.storage.set(STORAGE_KEYS.TAMPER_CONFIG, toJsonValue(config))
  }

  async getRefreshInterval(): Promise<number> {
    const raw = await this.storage.get(STORAGE_KEYS.REFRESH_INTERVAL)
    return (raw as unknown as number | null) ?? 900
  }

  async saveRefreshInterval(seconds: number): Promise<void> {
    await this.storage.set(STORAGE_KEYS.REFRESH_INTERVAL, toJsonValue(seconds))
  }
}
