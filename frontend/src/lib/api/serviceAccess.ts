import { fetchWithTimeout, getApiBaseFor, parseApiJson } from './utils';
import type { SaveServiceAccess, ServiceAccessSnapshot } from '../../../../shared/serviceAccessContracts';
export type { ServiceRole, ServiceAccessSnapshot } from '../../../../shared/serviceAccessContracts';
export async function serviceAccessRequest(server: string, token: string, update?: SaveServiceAccess): Promise<ServiceAccessSnapshot> {
    const response = await fetchWithTimeout(`${getApiBaseFor(server)}/admin/service-access`, {
        method: update ? 'PUT' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(update ? { body: JSON.stringify(update) } : {})
    });
    const data = await parseApiJson(response) as ServiceAccessSnapshot & { error?: string } | null;
    if (!response.ok) throw new Error(data?.error || `Service roles unavailable (${response.status})`);
    if (data?.access?.schema !== 1 || !Array.isArray(data.access.roles) || !Array.isArray(data.services) || !Array.isArray(data.members)) {
        throw new Error('This server does not support service roles. Update the server and reload.');
    }
    return data;
}
