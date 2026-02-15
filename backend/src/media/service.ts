import { randomUUID } from 'crypto';

export type MediaKind = 'audio' | 'video' | 'screen';

export interface MediaParticipant {
  socketId: string;
  userId: string;
  username: string;
  roomId: string;
  joinedAt: number;
  producerIds: Set<string>;
  consumerIds: Set<string>;
}

export interface ProducerTrack {
  id: string;
  roomId: string;
  ownerSocketId: string;
  kind: MediaKind;
  label?: string;
  simulcastLayers?: string[];
  createdAt: number;
}

export interface ConsumerTrack {
  id: string;
  roomId: string;
  producerId: string;
  subscriberSocketId: string;
  publisherSocketId: string;
  preferredLayer?: string;
  createdAt: number;
}

interface MediaRoom {
  id: string;
  participants: Map<string, MediaParticipant>;
  producers: Map<string, ProducerTrack>;
  consumers: Map<string, ConsumerTrack>;
}

function toPublicParticipant(participant: MediaParticipant) {
  return {
    socketId: participant.socketId,
    userId: participant.userId,
    username: participant.username,
    joinedAt: participant.joinedAt,
  };
}

export class MediaService {
  private readonly rooms = new Map<string, MediaRoom>();
  private readonly socketToRoom = new Map<string, string>();

  joinRoom(roomId: string, user: { socketId: string; userId: string; username: string }) {
    const room = this.getOrCreateRoom(roomId);

    const existing = room.participants.get(user.socketId);
    if (existing) {
      return {
        participant: toPublicParticipant(existing),
        participants: Array.from(room.participants.values()).map(toPublicParticipant),
        producers: Array.from(room.producers.values()),
      };
    }

    const participant: MediaParticipant = {
      socketId: user.socketId,
      userId: user.userId,
      username: user.username,
      roomId,
      joinedAt: Date.now(),
      producerIds: new Set<string>(),
      consumerIds: new Set<string>(),
    };

    room.participants.set(user.socketId, participant);
    this.socketToRoom.set(user.socketId, roomId);

    return {
      participant: toPublicParticipant(participant),
      participants: Array.from(room.participants.values()).map(toPublicParticipant),
      producers: Array.from(room.producers.values()),
    };
  }

  leaveRoom(socketId: string) {
    const roomId = this.socketToRoom.get(socketId);
    if (!roomId) return null;

    const room = this.rooms.get(roomId);
    if (!room) {
      this.socketToRoom.delete(socketId);
      return null;
    }

    const participant = room.participants.get(socketId);
    room.participants.delete(socketId);
    this.socketToRoom.delete(socketId);

    const removedProducerIds: string[] = [];
    const removedConsumerIds: string[] = [];

    for (const producer of Array.from(room.producers.values())) {
      if (producer.ownerSocketId === socketId) {
        removedProducerIds.push(producer.id);
        room.producers.delete(producer.id);
      }
    }

    for (const consumer of Array.from(room.consumers.values())) {
      if (consumer.subscriberSocketId === socketId || consumer.publisherSocketId === socketId) {
        removedConsumerIds.push(consumer.id);
        room.consumers.delete(consumer.id);
      }
    }

    if (room.participants.size === 0) {
      this.rooms.delete(roomId);
    }

    return {
      roomId,
      participant: participant ? toPublicParticipant(participant) : null,
      removedProducerIds,
      removedConsumerIds,
    };
  }

  publishTrack(socketId: string, data: { kind: MediaKind; label?: string; simulcastLayers?: string[] }) {
    const room = this.getRoomForSocket(socketId);
    if (!room) return null;

    const participant = room.participants.get(socketId);
    if (!participant) return null;

    const producer: ProducerTrack = {
      id: randomUUID(),
      roomId: room.id,
      ownerSocketId: socketId,
      kind: data.kind,
      label: data.label,
      simulcastLayers: data.simulcastLayers,
      createdAt: Date.now(),
    };

    room.producers.set(producer.id, producer);
    participant.producerIds.add(producer.id);

    return producer;
  }

  unpublishTrack(socketId: string, producerId: string) {
    const room = this.getRoomForSocket(socketId);
    if (!room) return null;

    const producer = room.producers.get(producerId);
    if (!producer || producer.ownerSocketId !== socketId) return null;

    room.producers.delete(producerId);
    room.participants.get(socketId)?.producerIds.delete(producerId);

    const removedConsumerIds: string[] = [];
    for (const consumer of Array.from(room.consumers.values())) {
      if (consumer.producerId === producerId) {
        removedConsumerIds.push(consumer.id);
        room.consumers.delete(consumer.id);
      }
    }

    return {
      roomId: room.id,
      producer,
      removedConsumerIds,
    };
  }

  createConsumer(socketId: string, data: { producerId: string; preferredLayer?: string }) {
    const room = this.getRoomForSocket(socketId);
    if (!room) return null;

    const producer = room.producers.get(data.producerId);
    if (!producer) return null;

    const subscriber = room.participants.get(socketId);
    if (!subscriber) return null;

    const consumer: ConsumerTrack = {
      id: randomUUID(),
      roomId: room.id,
      producerId: producer.id,
      subscriberSocketId: socketId,
      publisherSocketId: producer.ownerSocketId,
      preferredLayer: data.preferredLayer,
      createdAt: Date.now(),
    };

    room.consumers.set(consumer.id, consumer);
    subscriber.consumerIds.add(consumer.id);

    return consumer;
  }

  updateConsumerLayer(socketId: string, consumerId: string, preferredLayer?: string) {
    const room = this.getRoomForSocket(socketId);
    if (!room) return null;

    const consumer = room.consumers.get(consumerId);
    if (!consumer || consumer.subscriberSocketId !== socketId) return null;

    consumer.preferredLayer = preferredLayer;
    return consumer;
  }

  closeConsumer(socketId: string, consumerId: string) {
    const room = this.getRoomForSocket(socketId);
    if (!room) return null;

    const consumer = room.consumers.get(consumerId);
    if (!consumer || consumer.subscriberSocketId !== socketId) return null;

    room.consumers.delete(consumerId);
    room.participants.get(socketId)?.consumerIds.delete(consumerId);

    return consumer;
  }

  getParticipant(socketId: string) {
    const room = this.getRoomForSocket(socketId);
    if (!room) return null;

    return room.participants.get(socketId) || null;
  }

  private getOrCreateRoom(roomId: string): MediaRoom {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;

    const room: MediaRoom = {
      id: roomId,
      participants: new Map(),
      producers: new Map(),
      consumers: new Map(),
    };
    this.rooms.set(roomId, room);
    return room;
  }

  private getRoomForSocket(socketId: string): MediaRoom | null {
    const roomId = this.socketToRoom.get(socketId);
    if (!roomId) return null;
    return this.rooms.get(roomId) || null;
  }
}
