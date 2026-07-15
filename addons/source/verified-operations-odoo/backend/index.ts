import type { Server as SocketIOServer, Socket } from 'socket.io'
import type {
  BackendPlugin,
  PluginContext,
  PluginHttpRequest,
  PluginHttpResponse,
  PluginSocketPayload,
  JsonValue
} from '@wabi/plugin-types'
import { OdooClient } from './odoo-client'
import { ConfigManager } from './config-manager'
import { SpreadsheetEngine } from './spreadsheet-engine'
import { PermissionMapper } from './permission-mapper'
import { DraftManager } from './draft-manager'
import { ApprovalManager } from './approval-manager'
import { SnapshotVerifier } from './snapshot-verifier'
import { ConflictDetector } from './conflict-detector'
import { AuditLogger } from './audit-logger'
import { buildOdooBusinessRoutes } from './routes'
import type { ApprovalRequest } from '../shared/types'

// We never import socket.io at runtime, but the type is used in
// socketHandlers. The local typecheck harness has a stub for it.
void (null as unknown as SocketIOServer | null)

/**
 * Convert a domain object into a JsonValue-safe value for storage.
 *
 * The wabi PluginStorage contract uses a strict recursive JsonValue type
 * that requires every nested object to have an index signature. Domain
 * types in this addon are stronger than that (no index signature), so
 * we serialize through JSON and parse back as JsonValue. This round-trips
 * losslessly for the data we store (plain JSON-encodable objects) and
 * isolates the storage constraint to one place.
 */
export function toJsonValue<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function json(payload: JsonValue, status = 200): { status: number; body: string; headers: Record<string, string> } {
  return {
    status,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
  }
}

/**
 * Wabi-side bridge class that wraps the Odoo business addon's
 * services into a single loadable BackendPlugin.
 *
 * Lifetime:
 * - Wabi's addon loader instantiates one VerifiedOperationsOdooAddon
 *   per loaded addon.
 * - onLoad(ctx) wires the wabi PluginContext into the addon's services
 *   and starts the tamper verification timer.
 * - onUnload(ctx) cleans up the timer and disconnects from Odoo.
 *
 * Threading: the addon runs on a single thread per wabi process. All
 * Odoo RPCs are sequential via OdooClient.
 */
export class VerifiedOperationsOdooAddon implements BackendPlugin {
  name = 'verified-operations-odoo'

  private ctx: PluginContext | null = null
  private odoo: OdooClient | null = null
  private config: ConfigManager | null = null
  private engine: SpreadsheetEngine | null = null
  private permissions: PermissionMapper | null = null
  private drafts: DraftManager | null = null
  private approvals: ApprovalManager | null = null
  private verifier: SnapshotVerifier | null = null
  private conflicts: ConflictDetector | null = null
  private audit: AuditLogger | null = null
  private verifyTimer: ReturnType<typeof setInterval> | null = null

  async onLoad(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
    this.odoo = new OdooClient()
    this.config = new ConfigManager(ctx.storage)
    this.engine = new SpreadsheetEngine(this.odoo)
    this.permissions = new PermissionMapper()
    this.drafts = new DraftManager(ctx.storage)
    this.approvals = new ApprovalManager(ctx.storage, this.config, this.permissions, ctx.logger)
    this.verifier = new SnapshotVerifier(ctx.storage, this.odoo, ctx.logger)
    this.conflicts = new ConflictDetector(ctx.storage, this.odoo)
    this.audit = new AuditLogger(ctx.storage)

    await this.audit.init()
    ctx.logger.info('Business Spreadsheet Odoo addon loaded')

    const connConfig = await this.config.getOdooConnection()
    if (connConfig) {
      try {
        await this.odoo.connect(connConfig)
        ctx.logger.info('Auto-connected to Odoo')
      } catch (err) {
        ctx.logger.warn('Could not auto-connect to Odoo', { error: String(err) })
      }
    }

    this.startTamperVerification()
  }

  onUnload(_ctx: PluginContext): void {
    if (this.verifyTimer) {
      clearInterval(this.verifyTimer)
      this.verifyTimer = null
    }
    if (this.odoo) {
      this.odoo.disconnect()
    }
  }

  /**
   * Routes for the addon's HTTP surface. Each route has a method, a
   * path, and a handler that takes the wabi PluginHttpRequest and
   * PluginHttpResponse contracts (NOT the global Request/Response).
   * Handlers are wired in routes.ts so the index.ts file stays a
   * lifecycle file, not a request-dispatch table.
   */
  get routes(): { method?: 'get' | 'post' | 'put' | 'delete'; path: string; handler: (req: PluginHttpRequest, res: PluginHttpResponse) => void | Promise<void> }[] {
    if (!this.ctx || !this.odoo || !this.config || !this.engine || !this.permissions || !this.drafts || !this.approvals || !this.verifier || !this.conflicts || !this.audit) {
      throw new Error('VerifiedOperationsOdooAddon accessed before onLoad completed')
    }
    return buildOdooBusinessRoutes({
      ctx: this.ctx,
      odoo: this.odoo,
      config: this.config,
      engine: this.engine,
      permissions: this.permissions,
      drafts: this.drafts,
      approvals: this.approvals,
      verifier: this.verifier,
      conflicts: this.conflicts,
      audit: this.audit,
      json,
    })
  }

  get socketHandlers(): Record<string, (socket: Socket, data: PluginSocketPayload, ctx: PluginContext) => void | Promise<void>> {
    const self = this
    return {
      'biz:verify:now': async (_socket: Socket, _data: PluginSocketPayload) => {
        if (!self.odoo?.connected || !self.verifier) return
        const tamperConfig = await self.config!.getTamperConfig()
        const alerts = await self.verifier.verify(tamperConfig)
        if (alerts.length > 0 && self.ctx) {
          for (const alert of alerts) {
            self.ctx.emit('biz:tamper:alert', toJsonValue(alert))
          }
        }
      },
    }
  }

  private startTamperVerification(): void {
    const self = this
    const runVerification = async (): Promise<void> => {
      if (!self.odoo?.connected || !self.verifier) return
      try {
        const interval = await self.config!.getRefreshInterval()
        if (self.verifyTimer) {
          clearInterval(self.verifyTimer)
        }
        self.verifyTimer = setInterval(async () => {
          try {
            const tamperConfig = await self.config!.getTamperConfig()
            const alerts = await self.verifier!.verify(tamperConfig)
            if (alerts.length > 0 && self.ctx) {
              for (const alert of alerts) {
                self.ctx!.emit('biz:tamper:alert', toJsonValue(alert))
                self.ctx!.logger.warn('Tamper alert emitted', {
                  model: alert.model,
                  recordId: alert.odooRecordId,
                })
              }
            }
          } catch (err) {
            self.ctx?.logger.error('Tamper verification cycle failed', {
              error: String(err),
            })
          }
        }, interval * 1000)
      } catch (err) {
        self.ctx?.logger.error('Failed to start tamper verification', {
          error: String(err),
        })
      }
    }
    void runVerification()
  }
}

/**
 * ApprovalRequest.approvedAt is written by ApprovalManager but the
 * shared type currently doesn't declare it. We re-export the extended
 * type here so other code in the addon reads it consistently. Once
 * shared/types.ts catches up, this file can be deleted.
 */
export type { ApprovalRequest }
