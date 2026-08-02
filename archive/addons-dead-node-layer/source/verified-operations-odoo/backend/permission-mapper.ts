import type { OdooFieldMapping } from '../shared/types'

const ROLE_HIERARCHY: Record<string, number> = {
  owner: 100,
  admin: 80,
  director: 70,
  manager: 60,
  mod: 50,
  purchasing: 45,
  accounting: 45,
  estimator: 40,
  warehouse: 35,
  sales: 30,
  installer: 25,
  contributor: 20,
  viewer: 10,
  guest: 5,
}

export class PermissionMapper {
  getRoleRank(role: string): number {
    return ROLE_HIERARCHY[role.toLowerCase()] ?? 0
  }

  canViewSheet(userRole: string, sheetMinRole: string): boolean {
    return this.getRoleRank(userRole) >= this.getRoleRank(sheetMinRole)
  }

  canEditField(userRole: string, field: OdooFieldMapping): boolean {
    if (!field.editable) return false
    return this.getRoleRank(userRole) >= this.getRoleRank(field.minRole)
  }

  getEditableFields(
    userRole: string,
    fields: OdooFieldMapping[]
  ): OdooFieldMapping[] {
    return fields.filter((f) => this.canEditField(userRole, f))
  }

  filterFieldsByRole(
    userRole: string,
    fields: OdooFieldMapping[]
  ): OdooFieldMapping[] {
    return fields.filter((f) =>
      this.canViewSheet(userRole, f.minRole)
    )
  }

  canApprove(
    userRole: string,
    amount: number,
    caps: { role: string; maxAmount: number }[]
  ): { canApprove: boolean; exceedsCap: boolean; escalationRole?: string } {
    const cap = caps.find(
      (c) => c.role.toLowerCase() === userRole.toLowerCase()
    )
    if (!cap) {
      return { canApprove: false, exceedsCap: true }
    }
    if (amount > cap.maxAmount) {
      return { canApprove: false, exceedsCap: true }
    }
    return { canApprove: true, exceedsCap: false }
  }

  highestRole(userRoles: string[]): string {
    let highest = 'viewer'
    let highestRank = 0
    for (const role of userRoles) {
      const rank = this.getRoleRank(role)
      if (rank > highestRank) {
        highestRank = rank
        highest = role
      }
    }
    return highest
  }
}
