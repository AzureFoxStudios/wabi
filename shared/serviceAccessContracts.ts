/** Separate from highestRole / administrator authority. */
export interface ServiceRole { id: string; name: string; services: string[]; members: number[] }
export interface ServiceAccessSnapshot {
    access: { schema: 1; revision: string; updatedBy: number; roles: ServiceRole[] };
    services: { id: string; name: string; kind: string; exposed: boolean }[];
    members: { id: number; name: string }[];
}
export interface SaveServiceAccess { revision: string; roles: ServiceRole[] }
