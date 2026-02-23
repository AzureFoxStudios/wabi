/**
 * Business Routes
 * 
 * Handles business data CRUD operations:
 * - Todos, sprints, projects, calendar events, diary entries
 * - Resources management
 * - Tags and graph edges
 * 
 * Business data is stored per-workspace and supports both shared and private modes.
 */

import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { guestCodeRepository } from '../db/repositories/guestCodeRepository.js';
import { getCORSHeaders } from '../config/cors.js';

// Business data interface
interface BusinessData {
  workspaceId: string;
  todos: any[];
  calendarEvents: any[];
  diaryEntries: any[];
  projects: any[];
  sprints: any[];
  resources: any[];
  tags: any[];
  graphEdges: any[];
  lastUpdated: number;
}

// External dependencies - will be injected
let businessWorkspaces: Map<string, BusinessData>;
let defaultWorkspaceId: string;
let io: any;
let initializeWorkspace: (workspaceId: string) => BusinessData;
let saveBusinessData: (workspaceId: string, data: BusinessData) => void;
let emitToChannel: (channelId: string, event: string, data: any) => void;

export function initBusinessRoutes(
  workspaces: Map<string, BusinessData>,
  defaultWsId: string,
  socketIo: any,
  initWorkspaceFn: (workspaceId: string) => BusinessData,
  saveFn: (workspaceId: string, data: BusinessData) => void,
  emitFn: (channelId: string, event: string, data: any) => void
): void {
  businessWorkspaces = workspaces;
  defaultWorkspaceId = defaultWsId;
  io = socketIo;
  initializeWorkspace = initWorkspaceFn;
  saveBusinessData = saveFn;
  emitToChannel = emitFn;
}

function canUserSeeItem(item: any, requestingUserId: number | null): boolean {
  // Signed items are always considered shared.
  if (item?.signedBy) return true;

  const visibility = item?.visibility ?? 'public';
  if (visibility === 'public') return true;
  if (!requestingUserId) return false;

  // Private items are visible to their creator.
  const createdBy = item?.createdBy;
  if (createdBy === undefined || createdBy === null) return false;
  const createdByStr = String(createdBy);
  const requesterStr = String(requestingUserId);
  return createdByStr === requesterStr || createdByStr === `user-${requestingUserId}`;
}

function filterForUser(data: BusinessData, requestingUserId: number | null): BusinessData {
  return {
    ...data,
    todos: data.todos.filter(item => canUserSeeItem(item, requestingUserId)),
    projects: data.projects.filter(item => canUserSeeItem(item, requestingUserId)),
    sprints: data.sprints.filter(item => canUserSeeItem(item, requestingUserId)),
    calendarEvents: data.calendarEvents.filter(item => canUserSeeItem(item, requestingUserId)),
    diaryEntries: data.diaryEntries.filter(e => !e.isPrivate || (requestingUserId && e.createdBy === requestingUserId.toString()))
  };
}

function resolveWorkspaceId(userId: number): string {
  const userSettings = settingsRepository.get(userId);
  if (userSettings.business_private_mode === 1) {
    return `user-${userId}`;
  }
  return defaultWorkspaceId;
}

// Helper to get authenticated user ID from request
function getAuthenticatedUserId(req: any): number | null {
  // This is a simplified version - in production, you'd import the JWT verification
  // For now, we'll rely on the caller to pass the userId
  return null;
}

export async function handleGetBusinessData(req: any, res: any, userId: number | null): Promise<void> {
  try {
    // Default: shared workspace for collaboration
    let workspaceId = defaultWorkspaceId;

    // Check if user wants private workspace
    if (userId) {
      const userSettings = settingsRepository.get(userId);
      if (userSettings.business_private_mode === 1) {
        workspaceId = `user-${userId}`; // Private mode enabled
      }
    }

    let data = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

    // If user is in private mode, also merge signed items from shared workspace
    if (userId && workspaceId !== defaultWorkspaceId) {
      const sharedData = businessWorkspaces.get(defaultWorkspaceId);
      if (sharedData) {
        // Merge signed items from shared workspace (don't overwrite private workspace items with same id)
        const mergedData = { ...data };

        // Add shared signed items that aren't already in private workspace
        const privateIds = {
          todos: new Set(data.todos.map(t => t.id)),
          projects: new Set(data.projects.map(p => p.id)),
          sprints: new Set(data.sprints.map(s => s.id)),
          calendarEvents: new Set(data.calendarEvents.map(e => e.id))
        };

        mergedData.todos = [
          ...data.todos,
          ...sharedData.todos.filter(t => t.signedBy && !privateIds.todos.has(t.id))
        ];
        mergedData.projects = [
          ...data.projects,
          ...sharedData.projects.filter(p => p.signedBy && !privateIds.projects.has(p.id))
        ];
        mergedData.sprints = [
          ...data.sprints,
          ...sharedData.sprints.filter(s => s.signedBy && !privateIds.sprints.has(s.id))
        ];
        mergedData.calendarEvents = [
          ...data.calendarEvents,
          ...sharedData.calendarEvents.filter(e => e.signedBy && !privateIds.calendarEvents.has(e.id))
        ];

        data = mergedData;
      }
    }

    const filteredData = filterForUser(data, userId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      data: filteredData
    }));
  } catch (error) {
    console.error('Get business data error:', error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: 'Failed to load business data' }));
  }
}

export async function handleSyncBusinessData(req: any, res: any, userId: number | null, body: string): Promise<void> {
  // Default: shared workspace for collaboration
  let workspaceId = defaultWorkspaceId;

  // Guest validation: check for verified guest code
  if (!userId) {
    const guestCode = req.headers['x-guest-code'] as string;
    if (!guestCode || !guestCodeRepository.isValidCode(guestCode)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: false,
        error: 'Guest posting requires valid access code'
      }));
      return;
    }
  }

  if (userId) {
    const userSettings = settingsRepository.get(userId);
    if (userSettings.business_private_mode === 1) {
      workspaceId = `user-${userId}`; // Private mode enabled
    }
  }

  try {
    const { todos, calendarEvents, diaryEntries, projects, sprints, resources, tags, graphEdges } = JSON.parse(body);

    const businessData: BusinessData = {
      workspaceId,
      todos: todos || [],
      calendarEvents: calendarEvents || [],
      diaryEntries: diaryEntries || [],
      projects: projects || [],
      sprints: sprints || [],
      resources: resources || [],
      tags: tags || [],
      graphEdges: graphEdges || [],
      lastUpdated: Date.now()
    };

    businessWorkspaces.set(workspaceId, businessData);
    saveBusinessData(workspaceId, businessData);

    // If this is a private mode user, mirror signed items to the shared workspace
    if (userId && workspaceId !== defaultWorkspaceId) {
      const sharedData = businessWorkspaces.get(defaultWorkspaceId) || initializeWorkspace(defaultWorkspaceId);

      // Extract signed items from this user's data
      const signedTodos = todos?.filter((t: any) => t.signedBy) || [];
      const signedProjects = projects?.filter((p: any) => p.signedBy) || [];
      const signedSprints = sprints?.filter((s: any) => s.signedBy) || [];
      const signedCalendarEvents = calendarEvents?.filter((e: any) => e.signedBy) || [];

      // Merge signed items into shared workspace (upsert by id)
      for (const item of signedTodos) {
        const existingIdx = sharedData.todos.findIndex(t => t.id === item.id);
        if (existingIdx >= 0) {
          sharedData.todos[existingIdx] = item;
        } else {
          sharedData.todos.push(item);
        }
      }

      for (const item of signedProjects) {
        const existingIdx = sharedData.projects.findIndex(p => p.id === item.id);
        if (existingIdx >= 0) {
          sharedData.projects[existingIdx] = item;
        } else {
          sharedData.projects.push(item);
        }
      }

      for (const item of signedSprints) {
        const existingIdx = sharedData.sprints.findIndex(s => s.id === item.id);
        if (existingIdx >= 0) {
          sharedData.sprints[existingIdx] = item;
        } else {
          sharedData.sprints.push(item);
        }
      }

      for (const item of signedCalendarEvents) {
        const existingIdx = sharedData.calendarEvents.findIndex(e => e.id === item.id);
        if (existingIdx >= 0) {
          sharedData.calendarEvents[existingIdx] = item;
        } else {
          sharedData.calendarEvents.push(item);
        }
      }

      // Remove unsigned items that this user previously signed (only if they created them)
      const userIdStr = userId.toString();
      sharedData.todos = sharedData.todos.filter(t => !(t.createdBy === userIdStr && !t.signedBy));
      sharedData.projects = sharedData.projects.filter(p => !(p.createdBy === userIdStr && !p.signedBy));
      sharedData.sprints = sharedData.sprints.filter(s => !(s.createdBy === userIdStr && !s.signedBy));
      sharedData.calendarEvents = sharedData.calendarEvents.filter(e => !(e.createdBy === userIdStr && !e.signedBy));

      sharedData.lastUpdated = Date.now();
      businessWorkspaces.set(defaultWorkspaceId, sharedData);
      saveBusinessData(defaultWorkspaceId, sharedData);
    }

    // Broadcast update to all other connected users in this workspace
    io.emit('business-data-updated', { workspaceId });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      lastUpdated: businessData.lastUpdated
    }));
  } catch (error) {
    console.error('Sync business data error:', error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: 'Failed to sync business data' }));
  }
}

export async function handleGetResources(req: any, res: any, userId: number | null): Promise<void> {
  try {
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }

    const workspaceId = resolveWorkspaceId(userId);
    const data = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      resources: data.resources
    }));
  } catch (error) {
    console.error('Get resources error:', error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: 'Failed to load resources' }));
  }
}

export async function handleCreateResource(req: any, res: any, userId: number | null, body: string): Promise<void> {
  try {
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }

    const resourceData = JSON.parse(body);
    const workspaceId = resolveWorkspaceId(userId);
    const workspace = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

    const newResource = {
      id: `res-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ...resourceData,
      createdBy: String(userId),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    workspace.resources.push(newResource);
    businessWorkspaces.set(workspaceId, workspace);
    saveBusinessData(workspaceId, workspace);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      resource: newResource
    }));
  } catch (error) {
    console.error('Create resource error:', error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: 'Failed to create resource' }));
  }
}

export async function handleUpdateResource(req: any, res: any, userId: number | null, resourceId: string, body: string): Promise<void> {
  try {
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }

    const updates = JSON.parse(body);
    const workspaceId = resolveWorkspaceId(userId);
    const workspace = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

    const resourceIndex = workspace.resources.findIndex((r: any) => r.id === resourceId);
    if (resourceIndex === -1) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: 'Resource not found' }));
      return;
    }

    workspace.resources[resourceIndex] = {
      ...workspace.resources[resourceIndex],
      ...updates,
      updatedAt: Date.now()
    };

    businessWorkspaces.set(workspaceId, workspace);
    saveBusinessData(workspaceId, workspace);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      resource: workspace.resources[resourceIndex]
    }));
  } catch (error) {
    console.error('Update resource error:', error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: 'Failed to update resource' }));
  }
}

export async function handleDeleteResource(req: any, res: any, userId: number | null, resourceId: string): Promise<void> {
  try {
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid authorization' }));
      return;
    }

    const workspaceId = resolveWorkspaceId(userId);
    const workspace = businessWorkspaces.get(workspaceId) || initializeWorkspace(workspaceId);

    workspace.resources = workspace.resources.filter((r: any) => r.id !== resourceId);
    businessWorkspaces.set(workspaceId, workspace);
    saveBusinessData(workspaceId, workspace);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  } catch (error) {
    console.error('Delete resource error:', error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: 'Failed to delete resource' }));
  }
}
