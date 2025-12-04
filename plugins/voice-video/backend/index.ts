import type { BackendPlugin, PluginContext } from '../../../backend/src/plugins/types';
import type { Socket } from 'socket.io';

// This plugin handles WebRTC signaling for voice/video calls
// The actual media streams are peer-to-peer (not through server)

interface ActiveCall {
  callId: string;
  caller: string;
  callee: string;
  type: 'voice' | 'video';
  status: 'ringing' | 'active' | 'ended';
  startedAt: number;
}

const plugin: BackendPlugin = {
  name: 'voice-video',

  async onLoad(ctx: PluginContext) {
    console.log('📞 Voice & Video plugin loaded');
    console.log('   WebRTC signaling server active');
  },

  socketHandlers: {
    // Call initiation
    'call:initiate': (socket: Socket, data: { targetUserId: string; type: 'voice' | 'video' }, ctx: PluginContext) => {
      const caller = ctx.users.get(socket.id);
      const callee = ctx.users.get(data.targetUserId);

      if (!caller || !callee) {
        socket.emit('call:error', { message: 'User not found' });
        return;
      }

      const call: ActiveCall = {
        callId: `call-${Date.now()}`,
        caller: socket.id,
        callee: data.targetUserId,
        type: data.type,
        status: 'ringing',
        startedAt: Date.now()
      };

      // Notify callee
      ctx.io.to(data.targetUserId).emit('call:incoming', {
        callId: call.callId,
        caller: {
          id: caller.id,
          username: caller.username
        },
        type: data.type
      });

      console.log(`📞 ${data.type} call initiated: ${caller.username} → ${callee.username}`);
    },

    'call:accept': (socket: Socket, data: { callId: string }, ctx: PluginContext) => {
      console.log(`✅ Call accepted: ${data.callId}`);
      // Signal to both parties that call is starting
      socket.broadcast.emit('call:accepted', { callId: data.callId });
    },

    'call:reject': (socket: Socket, data: { callId: string }, ctx: PluginContext) => {
      console.log(`❌ Call rejected: ${data.callId}`);
      socket.broadcast.emit('call:rejected', { callId: data.callId });
    },

    'call:end': (socket: Socket, data: { callId: string }, ctx: PluginContext) => {
      console.log(`📴 Call ended: ${data.callId}`);
      socket.broadcast.emit('call:ended', { callId: data.callId });
    },

    // WebRTC signaling
    'call:offer': (socket: Socket, data: { targetId: string; offer: any }, ctx: PluginContext) => {
      ctx.io.to(data.targetId).emit('call:offer', {
        offer: data.offer,
        from: socket.id
      });
    },

    'call:answer': (socket: Socket, data: { targetId: string; answer: any }, ctx: PluginContext) => {
      ctx.io.to(data.targetId).emit('call:answer', {
        answer: data.answer,
        from: socket.id
      });
    },

    'call:ice-candidate': (socket: Socket, data: { targetId: string; candidate: any }, ctx: PluginContext) => {
      ctx.io.to(data.targetId).emit('call:ice-candidate', {
        candidate: data.candidate,
        from: socket.id
      });
    },

    // Screen sharing signaling
    'screen-share:start': (socket: Socket, data: any, ctx: PluginContext) => {
      const user = ctx.users.get(socket.id);
      if (!user) return;

      // Notify all users that screen sharing started
      socket.broadcast.emit('screen-share:started', {
        userId: socket.id,
        username: user.username
      });

      console.log(`🖥️  Screen share started by ${user.username}`);
    },

    'screen-share:stop': (socket: Socket, data: any, ctx: PluginContext) => {
      socket.broadcast.emit('screen-share:stopped', {
        userId: socket.id
      });

      console.log(`🖥️  Screen share stopped`);
    },

    'screen-share:offer': (socket: Socket, data: { targetId: string; offer: any }, ctx: PluginContext) => {
      ctx.io.to(data.targetId).emit('screen-share:offer', {
        offer: data.offer,
        from: socket.id
      });
    },

    'screen-share:answer': (socket: Socket, data: { targetId: string; answer: any }, ctx: PluginContext) => {
      ctx.io.to(data.targetId).emit('screen-share:answer', {
        answer: data.answer,
        from: socket.id
      });
    }
  },

  onDisconnect(socket: Socket, ctx: PluginContext) {
    // Clean up any active calls when user disconnects
    socket.broadcast.emit('call:ended', { userId: socket.id });
    socket.broadcast.emit('screen-share:stopped', { userId: socket.id });
  }
};

export default plugin;
