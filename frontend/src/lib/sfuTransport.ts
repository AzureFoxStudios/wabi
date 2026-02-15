import { writable, get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import { buildRTCConfig } from './turnConfig';

export const isSfuEnabled = import.meta.env.VITE_CALL_TRANSPORT !== 'p2p';

export interface MediaParticipant {
	socketId: string;
	userId: string;
	username: string;
	joinedAt: number;
}

export interface ProducerTrack {
	id: string;
	roomId: string;
	ownerSocketId: string;
	kind: 'audio' | 'video' | 'screen';
	label?: string;
	simulcastLayers?: string[];
	createdAt: number;
}

export const mediaParticipants = writable<MediaParticipant[]>([]);
export const remoteMediaStreams = writable<Record<string, MediaStream>>({});

const localTracksByProducerId = new Map<string, MediaStreamTrack>();
const producerToTrack = new Map<string, ProducerTrack>();
const subscriberPeerConnections = new Map<string, RTCPeerConnection>();
const publisherPeerConnections = new Map<string, RTCPeerConnection>();
const pendingSubscriptions = new Set<string>();

function getRTCConfig(): RTCConfiguration {
	return buildRTCConfig();
}

export function joinMediaRoom(socket: Socket, roomId: string): void {
	socket.emit('media-room-join', { roomId });
}

export function leaveMediaRoom(socket: Socket): void {
	socket.emit('media-room-leave');
	for (const pc of subscriberPeerConnections.values()) pc.close();
	for (const pc of publisherPeerConnections.values()) pc.close();
	subscriberPeerConnections.clear();
	publisherPeerConnections.clear();
	pendingSubscriptions.clear();
	producerToTrack.clear();
	localTracksByProducerId.clear();
	mediaParticipants.set([]);
	remoteMediaStreams.set({});
}

export function publishTrack(socket: Socket, track: MediaStreamTrack, kind: ProducerTrack['kind'], simulcastLayers?: string[]): void {
	socket.emit('media-track-publish', {
		kind,
		label: track.label,
		simulcastLayers
	});
}

export function unpublishTrack(socket: Socket, producerId: string): void {
	socket.emit('media-track-unpublish', { producerId });
	localTracksByProducerId.delete(producerId);
	producerToTrack.delete(producerId);
}

export function subscribeToProducer(socket: Socket, producerId: string, preferredLayer?: string): void {
	if (pendingSubscriptions.has(producerId)) return;
	pendingSubscriptions.add(producerId);
	socket.emit('media-consumer-create', { producerId, preferredLayer });
}

function ensureRemoteStream(consumerId: string): MediaStream {
	const current = get(remoteMediaStreams);
	if (current[consumerId]) return current[consumerId];
	const stream = new MediaStream();
	remoteMediaStreams.set({ ...current, [consumerId]: stream });
	return stream;
}

export function handleRoomJoined(socket: Socket, data: { participants: MediaParticipant[]; producers: ProducerTrack[] }): void {
	mediaParticipants.set(data.participants);
	for (const producer of data.producers) {
		producerToTrack.set(producer.id, producer);
		if (producer.ownerSocketId !== socket.id) {
			subscribeToProducer(socket, producer.id, producer.kind === 'video' ? 'mid' : undefined);
		}
	}
}

export function handleParticipantJoined(data: { participant: MediaParticipant }): void {
	mediaParticipants.update((participants) => {
		if (participants.some((p) => p.socketId === data.participant.socketId)) return participants;
		return [...participants, data.participant];
	});
}

export function handleParticipantLeft(data: { participant?: MediaParticipant | null; removedConsumerIds?: string[]; removedProducerIds?: string[] }): void {
	if (data.participant?.socketId) {
		mediaParticipants.update((participants) => participants.filter((p) => p.socketId !== data.participant?.socketId));
	}

	for (const consumerId of data.removedConsumerIds || []) {
		const pc = subscriberPeerConnections.get(consumerId);
		pc?.close();
		subscriberPeerConnections.delete(consumerId);
		remoteMediaStreams.update((streams) => {
			const next = { ...streams };
			delete next[consumerId];
			return next;
		});
	}

	for (const producerId of data.removedProducerIds || []) {
		producerToTrack.delete(producerId);
		pendingSubscriptions.delete(producerId);
	}
}

export function handleTrackAvailable(socket: Socket, producer: ProducerTrack): void {
	producerToTrack.set(producer.id, producer);
	if (producer.ownerSocketId !== socket.id) {
		subscribeToProducer(socket, producer.id, producer.kind === 'video' ? 'mid' : undefined);
	}
}

export function handleTrackUnpublished(data: { producerId: string; removedConsumerIds?: string[] }): void {
	producerToTrack.delete(data.producerId);
	pendingSubscriptions.delete(data.producerId);
	for (const consumerId of data.removedConsumerIds || []) {
		const pc = subscriberPeerConnections.get(consumerId);
		pc?.close();
		subscriberPeerConnections.delete(consumerId);
	}
}

export async function handleConsumerCreated(socket: Socket, data: { id: string; producerId: string; publisherSocketId: string }): Promise<void> {
	pendingSubscriptions.delete(data.producerId);
	const pc = new RTCPeerConnection(getRTCConfig());
	subscriberPeerConnections.set(data.id, pc);

	pc.onicecandidate = (event) => {
		if (event.candidate) {
			socket.emit('media-subscriber-ice-candidate', {
				targetId: data.publisherSocketId,
				consumerId: data.id,
				candidate: event.candidate
			});
		}
	};

	pc.ontrack = (event) => {
		const stream = ensureRemoteStream(data.id);
		stream.addTrack(event.track);
	};
}

export async function handleConsumerRequest(socket: Socket, data: { consumerId: string; producerId: string; subscriberSocketId: string }): Promise<void> {
	const track = localTracksByProducerId.get(data.producerId);
	if (!track) return;

	const pc = new RTCPeerConnection(getRTCConfig());
	publisherPeerConnections.set(data.consumerId, pc);
	pc.addTrack(track, new MediaStream([track]));

	pc.onicecandidate = (event) => {
		if (event.candidate) {
			socket.emit('media-subscriber-ice-candidate', {
				targetId: data.subscriberSocketId,
				consumerId: data.consumerId,
				candidate: event.candidate
			});
		}
	};

	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);
	socket.emit('media-subscriber-offer', {
		targetId: data.subscriberSocketId,
		producerId: data.producerId,
		consumerId: data.consumerId,
		offer
	});
}

export async function handleSubscriberOffer(socket: Socket, data: { senderId: string; consumerId: string; offer: RTCSessionDescriptionInit }): Promise<void> {
	const pc = subscriberPeerConnections.get(data.consumerId);
	if (!pc) return;
	await pc.setRemoteDescription(data.offer);
	const answer = await pc.createAnswer();
	await pc.setLocalDescription(answer);
	socket.emit('media-subscriber-answer', {
		targetId: data.senderId,
		consumerId: data.consumerId,
		answer
	});
}

export async function handleSubscriberAnswer(data: { consumerId: string; answer: RTCSessionDescriptionInit }): Promise<void> {
	const pc = publisherPeerConnections.get(data.consumerId);
	if (!pc) return;
	await pc.setRemoteDescription(data.answer);
}

export async function handleSubscriberIceCandidate(data: { senderId: string; consumerId: string; candidate: RTCIceCandidateInit }): Promise<void> {
	const pc = subscriberPeerConnections.get(data.consumerId) || publisherPeerConnections.get(data.consumerId);
	if (!pc) return;
	await pc.addIceCandidate(data.candidate);
}

export function handleTrackPublished(track: ProducerTrack, localTrack?: MediaStreamTrack): void {
	producerToTrack.set(track.id, track);
	if (localTrack && track.ownerSocketId) {
		localTracksByProducerId.set(track.id, localTrack);
	}
}

export function updateConsumerLayer(socket: Socket, consumerId: string, preferredLayer?: string): void {
	socket.emit('media-consumer-layer', { consumerId, preferredLayer });
}
