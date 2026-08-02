import type {
  PluginContext,
  PluginHttpRequest,
  PluginHttpResponse,
  JsonValue
} from '@wabi/plugin-types'
import type { OdooClient } from './odoo-client'
import type { ConfigManager } from './config-manager'
import type { SpreadsheetEngine } from './spreadsheet-engine'
import type { PermissionMapper } from './permission-mapper'
import type { DraftManager } from './draft-manager'
import type { ApprovalManager } from './approval-manager'
import type { SnapshotVerifier } from './snapshot-verifier'
import type { ConflictDetector } from './conflict-detector'
import type { AuditLogger } from './audit-logger'
import { toJsonValue } from './index'

export interface OdooBusinessRouteContext {
  ctx: PluginContext
  odoo: OdooClient
  config: ConfigManager
  engine: SpreadsheetEngine
  permissions: PermissionMapper
  drafts: DraftManager
  approvals: ApprovalManager
  verifier: SnapshotVerifier
  conflicts: ConflictDetector
  audit: AuditLogger
  json: (payload: JsonValue, status?: number) => { status: number; body: string; headers: Record<string, string> }
}

type RouteHandler = (req: PluginHttpRequest, res: PluginHttpResponse) => void | Promise<void>
type Route = { method?: 'get' | 'post' | 'put' | 'delete'; path: string; handler: RouteHandler }

const ok = (data: JsonValue) => ({ status: 200, body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } })
const err = (message: string, status = 400) => ({ status, body: JSON.stringify({ error: message }), headers: { 'Content-Type': 'application/json' } })

export function buildOdooBusinessRoutes(c: OdooBusinessRouteContext): Route[] {
  return [
    // --- Status / lifecycle ---
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/status',
      handler: async (req, res) => {
        const drafts = await c.drafts.list()
        res.status(200).json(ok({
          connected: c.odoo.connected,
          odooHost: c.odoo.connectionConfig?.host ?? null,
          draftCount: drafts.length,
          pendingApprovals: await c.approvals.getPendingCount(),
          tamperAlerts: await c.verifier.getUnacknowledgedCount(),
        }).body)
      },
    },

    // --- Connection ---
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/connect',
      handler: async (req, res) => {
        const body = await req.json()
        try {
          await c.odoo.connect(body as unknown as Parameters<OdooClient['connect']>[0])
          await c.config.saveOdooConnection(body as unknown as Parameters<ConfigManager['saveOdooConnection']>[0])
          await c.audit.log({
            action: 'odoo:connected',
            actorId: 'admin',
            actorRole: 'admin',
            details: { host: (body as Record<string, unknown>).host as string },
          })
          res.status(200).json(ok({ success: true }).body)
        } catch (e) {
          res.status(400).json(err(String(e), 400).body)
        }
      },
    },
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/disconnect',
      handler: async (_req, res) => {
        c.odoo.disconnect()
        await c.config.clearOdooConnection()
        res.status(200).json(ok({ success: true }).body)
      },
    },

    // --- Odoo model metadata ---
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/models',
      handler: async (_req, res) => {
        if (!c.odoo.connected) { res.status(400).json(err('Not connected', 400).body); return }
        try {
          const models = await c.odoo.getModels()
          res.status(200).json(ok({ models }).body)
        } catch (e) {
          res.status(500).json(err(String(e), 500).body)
        }
      },
    },
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/models/:model/info',
      handler: async (_req, res) => {
        if (!c.odoo.connected) { res.status(400).json(err('Not connected', 400).body); return }
        try {
          // The wabi plugin path param is exposed via the request URL/params
          // surface. We use the URL path tail to identify the model name.
          const tail = new URL(_req.url).pathname.split('/models/').pop()?.replace('/info', '') ?? ''
          const info = await c.odoo.getModelInfo(tail)
          res.status(200).json(ok(toJsonValue(info)).body)
        } catch (e) {
          res.status(500).json(err(String(e), 500).body)
        }
      },
    },

    // --- Spreadsheet definitions ---
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/sheets',
      handler: async (req, res) => {
        const body = await req.json() as Record<string, unknown>
        body.id = (body.id as string) || `sheet:${Date.now()}`
        body.createdAt = Date.now()
        await c.config.saveSpreadsheetDef(body as unknown as Parameters<ConfigManager['saveSpreadsheetDef']>[0])
        res.status(200).json(ok({ id: body.id as string }).body)
      },
    },
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/sheets',
      handler: async (_req, res) => {
        const defs = await c.config.getSpreadsheetDefs()
        res.status(200).json(ok(toJsonValue(defs)).body)
      },
    },
    {
      method: 'delete',
      path: '/api/plugins/runtime/verified-operations-odoo/sheets/:id',
      handler: async (_req, res) => {
        const tail = new URL(_req.url).pathname.split('/sheets/').pop() ?? ''
        await c.config.deleteSpreadsheetDef(tail)
        res.status(200).json(ok({ success: true }).body)
      },
    },
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/sheets/:id/data',
      handler: async (req, res) => {
        if (!c.odoo.connected) { res.status(400).json(err('Not connected', 400).body); return }
        const tail = new URL(req.url).pathname.split('/sheets/').pop()?.replace('/data', '') ?? ''
        const defs = await c.config.getSpreadsheetDefs()
        const def = defs.find((d) => d.id === tail)
        if (!def) { res.status(404).json(err('Sheet not found', 404).body); return }
        try {
          const options = await req.json()
          const data = await c.engine.fetchData(def, options as Parameters<SpreadsheetEngine['fetchData']>[1])
          res.status(200).json(ok(toJsonValue(data)).body)
        } catch (e) {
          res.status(500).json(err(String(e), 500).body)
        }
      },
    },

    // --- Drafts ---
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/drafts',
      handler: async (_req, res) => {
        const drafts = await c.drafts.list()
        res.status(200).json(ok(toJsonValue(drafts)).body)
      },
    },
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/drafts',
      handler: async (req, res) => {
        const draft = await req.json() as Record<string, unknown>
        draft.id = (draft.id as string) || `draft:${Date.now()}`
        draft.createdAt = Date.now()
        draft.updatedAt = Date.now()
        draft.status = 'draft'
        draft.attachments = []
        await c.drafts.create(draft as unknown as Parameters<DraftManager['create']>[0])
        res.status(200).json(ok({ id: draft.id as string }).body)
      },
    },
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/drafts/:id',
      handler: async (_req, res) => {
        const tail = new URL(_req.url).pathname.split('/drafts/').pop() ?? ''
        const draft = await c.drafts.get(tail)
        if (!draft) { res.status(404).json(err('Not found', 404).body); return }
        res.status(200).json(ok(toJsonValue(draft)).body)
      },
    },
    {
      method: 'put',
      path: '/api/plugins/runtime/verified-operations-odoo/drafts/:id',
      handler: async (req, res) => {
        const tail = new URL(req.url).pathname.split('/drafts/').pop() ?? ''
        const updates = await req.json()
        await c.drafts.update(tail, updates as Parameters<DraftManager['update']>[1])
        res.status(200).json(ok({ success: true }).body)
      },
    },
    {
      method: 'delete',
      path: '/api/plugins/runtime/verified-operations-odoo/drafts/:id',
      handler: async (_req, res) => {
        const tail = new URL(_req.url).pathname.split('/drafts/').pop() ?? ''
        await c.drafts.delete(tail)
        res.status(200).json(ok({ success: true }).body)
      },
    },
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/drafts/:id/submit',
      handler: async (req, res) => {
        const tail = new URL(req.url).pathname.split('/drafts/').pop()?.replace('/submit', '') ?? ''
        const draft = await c.drafts.get(tail)
        if (!draft) { res.status(404).json(err('Draft not found', 404).body); return }

        const body = await req.json() as { requesterId: string; requesterName: string; requesterRole: string; amount?: number; currency?: string; channelId?: string }
        const totalAmount = body.amount ?? 0

        const approvalRequest = {
          id: `apr:${Date.now()}`,
          draftId: tail,
          requesterId: body.requesterId,
          requesterName: body.requesterName,
          currentRole: body.requesterRole,
          amount: totalAmount,
          currency: body.currency ?? 'THB',
          currentTier: body.requesterRole,
          status: 'pending' as const,
          reviewers: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

        await c.approvals.submit(approvalRequest)
        await c.drafts.update(tail, { status: 'pending' })

        await c.audit.log({
          action: 'draft:submitted',
          actorId: body.requesterId,
          actorRole: body.requesterRole,
          details: { draftId: tail, amount: totalAmount },
        })

        c.ctx.emitToChannel(draft.channelId, 'biz:approval:submit', toJsonValue({
          draftId: tail,
          status: 'pending',
        }))

        res.status(200).json(ok({ id: approvalRequest.id, status: 'pending' }).body)
      },
    },

    // --- Approvals ---
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/approvals',
      handler: async (_req, res) => {
        const requests = await c.approvals.list()
        res.status(200).json(ok(toJsonValue(requests)).body)
      },
    },
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/approvals/:id/review',
      handler: async (req, res) => {
        const tail = new URL(req.url).pathname.split('/approvals/').pop()?.replace('/review', '') ?? ''
        const body = await req.json() as { userId: string; role: string; decision: 'approved' | 'rejected'; reason?: string }
        const caps = await c.config.getSpendingCaps()

        try {
          const result = await c.approvals.review(
            tail,
            {
              userId: body.userId,
              role: body.role,
              decision: body.decision,
              reason: body.reason,
              decidedAt: Date.now(),
            },
            caps,
          )

          await c.audit.logApproval(body.userId, body.role, tail, body.decision, body.reason)

          if (result.approved) {
            const requests = await c.approvals.list()
            const request = await c.approvals.getByDraftId(
              requests.find((r) => r.id === tail)?.draftId ?? ''
            )
            if (request) {
              await c.drafts.update(request.draftId, { status: 'approved' })
            }
          }

          res.status(200).json(ok(toJsonValue(result)).body)
        } catch (e) {
          res.status(400).json(err(String(e), 400).body)
        }
      },
    },
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/approvals/:id/push',
      handler: async (req, res) => {
        if (!c.odoo.connected) { res.status(400).json(err('Not connected', 400).body); return }

        const tail = new URL(req.url).pathname.split('/approvals/').pop()?.replace('/push', '') ?? ''
        const body = await req.json() as { model: string; values: Record<string, unknown>; userId: string; role: string }
        const request = (await c.approvals.list()).find((r) => r.id === tail)
        if (!request) { res.status(404).json(err('Request not found', 404).body); return }
        if (request.status !== 'approved') { res.status(400).json(err('Not approved', 400).body); return }

        const draft = await c.drafts.get(request.draftId)
        if (!draft) { res.status(404).json(err('Draft not found', 404).body); return }

        try {
          const recordId = await c.odoo.create(body.model, body.values)
          await c.drafts.update(request.draftId, {
            status: 'pushed',
            pushedToOdoo: { model: body.model, recordId, pushedAt: Date.now() },
          })

          const tamperConfig = await c.config.getTamperConfig()
          await c.verifier.storeSnapshot(
            body.model,
            recordId,
            body.values,
            request.reviewers.find((r) => r.decision === 'approved')?.userId ?? 'unknown',
            tamperConfig
          )

          await c.audit.logPush(body.userId, body.role, body.model, recordId, request.draftId)
          res.status(200).json(ok({ success: true, recordId }).body)
        } catch (e) {
          await c.audit.log({
            action: 'odoo:push-failed',
            actorId: body.userId,
            actorRole: body.role,
            details: { draftId: request.draftId, model: body.model, error: String(e) },
          })
          res.status(500).json(err(String(e), 500).body)
        }
      },
    },

    // --- Tamper verification ---
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/verify/stats',
      handler: async (_req, res) => {
        const stats = await c.verifier.getVerificationStats()
        const unacknowledged = await c.verifier.getUnacknowledgedCount()
        res.status(200).json(ok(toJsonValue({ ...stats, unacknowledged })).body)
      },
    },
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/verify/run',
      handler: async (_req, res) => {
        if (!c.odoo.connected || !c.verifier) {
          res.status(400).json(err('Not connected', 400).body)
          return
        }
        const tamperConfig = await c.config.getTamperConfig()
        const alerts = await c.verifier.verify(tamperConfig)
        res.status(200).json(ok(toJsonValue({ alertsDetected: alerts.length, alerts })).body)
      },
    },
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/verify/acknowledge/:alertId',
      handler: async (req, res) => {
        const tail = new URL(req.url).pathname.split('/acknowledge/').pop() ?? ''
        const body = await req.json() as { userId: string }
        await c.verifier.acknowledgeAlert(tail, body.userId)
        res.status(200).json(ok({ success: true }).body)
      },
    },

    // --- Conflicts ---
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/conflicts',
      handler: async (_req, res) => {
        const conflicts = await c.conflicts.list()
        res.status(200).json(ok(toJsonValue(conflicts)).body)
      },
    },
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/conflicts/:id/resolve',
      handler: async (req, res) => {
        const tail = new URL(req.url).pathname.split('/conflicts/').pop()?.replace('/resolve', '') ?? ''
        const body = await req.json() as { resolution: 'accept-wabi' | 'accept-odoo'; userId: string }
        await c.conflicts.resolve(tail, body.resolution, body.userId)
        res.status(200).json(ok({ success: true }).body)
      },
    },

    // --- Caps / tamper config / templates / audit ---
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/caps',
      handler: async (_req, res) => {
        const caps = await c.config.getSpendingCaps()
        res.status(200).json(ok(toJsonValue(caps)).body)
      },
    },
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/caps',
      handler: async (req, res) => {
        const caps = await req.json()
        await c.config.saveSpendingCaps(caps as unknown as Parameters<ConfigManager['saveSpendingCaps']>[0])
        res.status(200).json(ok({ success: true }).body)
      },
    },
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/tamper-config',
      handler: async (_req, res) => {
        const config = await c.config.getTamperConfig()
        res.status(200).json(ok(toJsonValue(config)).body)
      },
    },
    {
      method: 'post',
      path: '/api/plugins/runtime/verified-operations-odoo/tamper-config',
      handler: async (req, res) => {
        const config = await req.json()
        await c.config.saveTamperConfig(config as unknown as Parameters<ConfigManager['saveTamperConfig']>[0])
        res.status(200).json(ok({ success: true }).body)
      },
    },
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/templates',
      handler: async (_req, res) => {
        const templates = await c.drafts.getTemplates()
        res.status(200).json(ok(toJsonValue(templates)).body)
      },
    },
    {
      method: 'get',
      path: '/api/plugins/runtime/verified-operations-odoo/audit',
      handler: async (req, res) => {
        const url = new URL(req.url)
        const filters = {
          action: url.searchParams.get('action') ?? undefined,
          actorId: url.searchParams.get('actorId') ?? undefined,
          model: url.searchParams.get('model') ?? undefined,
          since: url.searchParams.get('since') ? parseInt(url.searchParams.get('since') as string) : undefined,
          limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit') as string) : undefined,
        }
        const events = await c.audit.query(filters)
        res.status(200).json(ok(toJsonValue(events)).body)
      },
    },
  ]
}
