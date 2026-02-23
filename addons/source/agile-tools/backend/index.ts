import type { BackendPlugin, PluginContext } from '../../../backend/src/plugins/types';
import type { Socket } from 'socket.io';

interface Task {
  id: string;
  title: string;
  description: string;
  status: 'todo' | 'in-progress' | 'done';
  assignee?: string;
  priority: 'low' | 'medium' | 'high';
  storyPoints?: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  sprintId?: string;
}

interface Sprint {
  id: string;
  name: string;
  startDate?: number;
  endDate?: number;
  status: 'planning' | 'active' | 'completed';
  tasks: string[];
  createdBy: string;
  createdAt: number;
}

const plugin: BackendPlugin = {
  name: 'agile-tools',

  async onLoad(ctx: PluginContext) {
    console.log('📊 Agile Tools plugin loaded');

    // Initialize storage
    const tasks = await ctx.storage.get('tasks') || [];
    const sprints = await ctx.storage.get('sprints') || [];

    console.log(`  📋 Loaded ${tasks.length} tasks and ${sprints.length} sprints`);
  },

  onConnection(socket: Socket, ctx: PluginContext) {
    // Send initial data when user connects
    ctx.storage.get('tasks').then(tasks => {
      socket.emit('task:list', tasks || []);
    });
  },

  socketHandlers: {
    'task:create': async (socket: Socket, data: Partial<Task>, ctx: PluginContext) => {
      const user = ctx.users.get(socket.id);
      if (!user) return;

      const task: Task = {
        id: `task-${Date.now()}-${socket.id.slice(0, 6)}`,
        title: data.title || 'Untitled Task',
        description: data.description || '',
        status: 'todo',
        assignee: data.assignee,
        priority: data.priority || 'medium',
        storyPoints: data.storyPoints,
        createdBy: user.username,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sprintId: data.sprintId
      };

      // Get existing tasks
      const tasks = await ctx.storage.get('tasks') || [];
      tasks.push(task);
      await ctx.storage.set('tasks', tasks);

      // Broadcast to all users
      ctx.emit('task:created', task);

      console.log(`✅ Task created: ${task.title} by ${user.username}`);
    },

    'task:update': async (socket: Socket, data: { id: string; updates: Partial<Task> }, ctx: PluginContext) => {
      const tasks = await ctx.storage.get('tasks') || [];
      const taskIndex = tasks.findIndex((t: Task) => t.id === data.id);

      if (taskIndex === -1) {
        socket.emit('task:error', { message: 'Task not found' });
        return;
      }

      tasks[taskIndex] = {
        ...tasks[taskIndex],
        ...data.updates,
        updatedAt: Date.now()
      };

      await ctx.storage.set('tasks', tasks);
      ctx.emit('task:updated', tasks[taskIndex]);

      console.log(`✏️  Task updated: ${tasks[taskIndex].id}`);
    },

    'task:delete': async (socket: Socket, data: { id: string }, ctx: PluginContext) => {
      const tasks = await ctx.storage.get('tasks') || [];
      const filteredTasks = tasks.filter((t: Task) => t.id !== data.id);

      if (tasks.length === filteredTasks.length) {
        socket.emit('task:error', { message: 'Task not found' });
        return;
      }

      await ctx.storage.set('tasks', filteredTasks);
      ctx.emit('task:deleted', { id: data.id });

      console.log(`🗑️  Task deleted: ${data.id}`);
    },

    'task:list': async (socket: Socket, data: any, ctx: PluginContext) => {
      const tasks = await ctx.storage.get('tasks') || [];
      socket.emit('task:list', tasks);
    },

    'sprint:create': async (socket: Socket, data: { name: string }, ctx: PluginContext) => {
      const user = ctx.users.get(socket.id);
      if (!user) return;

      const sprint: Sprint = {
        id: `sprint-${Date.now()}`,
        name: data.name,
        status: 'planning',
        tasks: [],
        createdBy: user.username,
        createdAt: Date.now()
      };

      const sprints = await ctx.storage.get('sprints') || [];
      sprints.push(sprint);
      await ctx.storage.set('sprints', sprints);

      ctx.emit('sprint:created', sprint);
      console.log(`🏃 Sprint created: ${sprint.name}`);
    },

    'sprint:start': async (socket: Socket, data: { id: string }, ctx: PluginContext) => {
      const sprints = await ctx.storage.get('sprints') || [];
      const sprint = sprints.find((s: Sprint) => s.id === data.id);

      if (!sprint) {
        socket.emit('sprint:error', { message: 'Sprint not found' });
        return;
      }

      sprint.status = 'active';
      sprint.startDate = Date.now();

      await ctx.storage.set('sprints', sprints);
      ctx.emit('sprint:started', sprint);

      console.log(`▶️  Sprint started: ${sprint.name}`);
    },

    'burndown:get': async (socket: Socket, data: { sprintId: string }, ctx: PluginContext) => {
      const tasks = await ctx.storage.get('tasks') || [];
      const sprintTasks = tasks.filter((t: Task) => t.sprintId === data.sprintId);

      const totalPoints = sprintTasks.reduce((sum: number, t: Task) => sum + (t.storyPoints || 0), 0);
      const completedPoints = sprintTasks
        .filter((t: Task) => t.status === 'done')
        .reduce((sum: number, t: Task) => sum + (t.storyPoints || 0), 0);

      socket.emit('burndown:data', {
        sprintId: data.sprintId,
        totalPoints,
        completedPoints,
        remainingPoints: totalPoints - completedPoints,
        tasks: sprintTasks
      });
    }
  },

  routes: [
    {
      method: 'get',
      path: '/tasks',
      handler: async (req, res) => {
        // Access storage through plugin context
        // Note: This is a simplified version, in production you'd pass storage through middleware
        res.json({ message: 'Use WebSocket events for task operations' });
      }
    }
  ],

  onMessage(channelId: string, message: any, ctx: PluginContext) {
    // Listen for task commands in messages
    if (message.text.startsWith('/task')) {
      // Handle /task command
      console.log('📝 Task command detected:', message.text);
    }
  }
};

export default plugin;
