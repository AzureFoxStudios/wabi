import type { PluginStorage, PluginLogger } from '@wabi/plugin-types'
import type { ApprovalRequest, ApprovalReviewer, SpendingCap } from '../shared/types'
import { ConfigManager } from './config-manager'
import { PermissionMapper } from './permission-mapper'
import { toJsonValue } from './index'

export class ApprovalManager {
  constructor(
    private storage: PluginStorage,
    private config: ConfigManager,
    private permissions: PermissionMapper,
    private logger: PluginLogger
  ) {}

  async submit(request: ApprovalRequest): Promise<void> {
    const caps = await this.config.getSpendingCaps()
    const userCap = caps.find(
      (c) => c.role.toLowerCase() === request.currentRole.toLowerCase()
    )

    if (userCap && request.amount > userCap.maxAmount && userCap.escalationRole) {
      request.status = 'pending'
      request.currentTier = userCap.escalationRole
      this.logger.info('Approval request escalated', {
        draftId: request.draftId,
        amount: request.amount,
        fromRole: request.currentRole,
        toRole: userCap.escalationRole,
      })
    } else {
      request.status = 'pending'
    }

    const requests = await this.list()
    requests.push(request)
    await this.storage.set('biz:approvals', toJsonValue(requests))
  }

  async list(filters?: {
    status?: string
    reviewerId?: string
  }): Promise<ApprovalRequest[]> {
    const raw = await this.storage.get('biz:approvals')
    const requests = (raw as unknown as ApprovalRequest[] | null) ?? []
    if (!requests) return []

    let filtered = requests
    if (filters?.status) {
      filtered = filtered.filter((r: ApprovalRequest) => r.status === filters.status)
    }
    if (filters?.reviewerId) {
      filtered = filtered.filter((r: ApprovalRequest) =>
        r.reviewers.some((rev: ApprovalReviewer) => rev.userId === filters.reviewerId)
      )
    }
    return filtered.sort((a: ApprovalRequest, b: ApprovalRequest) => b.createdAt - a.createdAt)
  }

  async review(
    requestId: string,
    reviewer: ApprovalReviewer,
    caps: SpendingCap[]
  ): Promise<{ approved: boolean; escalated: boolean }> {
    const requests = await this.list()
    const idx = requests.findIndex((r) => r.id === requestId)
    if (idx < 0) throw new Error(`Approval request not found: ${requestId}`)

    const request = requests[idx]
    if (request.status !== 'pending') {
      throw new Error(`Request ${requestId} is not pending`)
    }

    const existingIdx = request.reviewers.findIndex(
      (r) => r.userId === reviewer.userId
    )
    if (existingIdx >= 0) {
      request.reviewers[existingIdx] = reviewer
    } else {
      request.reviewers.push(reviewer)
    }
    request.updatedAt = Date.now()

    if (reviewer.decision === 'rejected') {
      request.status = 'rejected'
      await this.storage.set('biz:approvals', toJsonValue(requests))
      this.logger.info('Approval request rejected', {
        requestId,
        by: reviewer.userId,
        reason: reviewer.reason,
      })
      return { approved: false, escalated: false }
    }

    const requesterRank = this.permissions.getRoleRank(request.currentRole)
    const currentCap = caps.find(
      (c) => this.permissions.getRoleRank(c.role) <= requesterRank
    )

    if (currentCap && request.amount > currentCap.maxAmount && currentCap.escalationRole) {
      request.currentTier = currentCap.escalationRole
      request.status = 'pending'
      this.logger.info('Approval request escalated after review', {
        requestId,
        amount: request.amount,
        toRole: currentCap.escalationRole,
      })
      await this.storage.set('biz:approvals', toJsonValue(requests))
      return { approved: false, escalated: true }
    }

    request.status = 'approved'
    request.approvedAt = Date.now()
    await this.storage.set('biz:approvals', toJsonValue(requests))

    this.logger.info('Approval request approved', {
      requestId,
      by: reviewer.userId,
    })
    return { approved: true, escalated: false }
  }

  async getByDraftId(draftId: string): Promise<ApprovalRequest | null> {
    const requests = await this.list()
    return requests.find((r) => r.draftId === draftId) ?? null
  }

  async getPendingCount(): Promise<number> {
    const requests = await this.list({ status: 'pending' })
    return requests.length
  }
}
