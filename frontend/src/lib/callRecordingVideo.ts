/**
 * callRecordingVideo.ts
 * Video composition and rendering for call recording
 */

import {
	buildActiveSpeakerLevels,
	buildParticipants,
	buildRenderTiles,
	buildShares,
	getInitial,
	type RenderTile
} from './callRenderModel';
import { computeCallLayout, DEFAULT_ACTIVE_SPEAKER_STATE, type ActiveSpeakerState } from './callLayoutManager';
import type { CallRecordingPresetConfig, CallRecordingSnapshot, TileRect } from './callRecordingTypes';
import { colorFromLabel } from './callRecordingUtils';

export class RecordingVideoComposer {
	private readonly canvas: HTMLCanvasElement;
	private readonly context: CanvasRenderingContext2D;
	private readonly stream: MediaStream;
	private readonly videoElements = new Map<string, HTMLVideoElement>();
	private readonly width: number;
	private readonly height: number;
	private readonly frameRate: number;
	private activeSpeakerState: ActiveSpeakerState = { ...DEFAULT_ACTIVE_SPEAKER_STATE };
	private renderInterval: ReturnType<typeof setInterval> | null = null;
	private orderedTiles: RenderTile[] = [];
	private heroTileIds: string[] = [];

	constructor(preset: CallRecordingPresetConfig) {
		this.width = preset.width;
		this.height = preset.height;
		this.frameRate = preset.frameRate;
		this.canvas = document.createElement('canvas');
		this.canvas.width = this.width;
		this.canvas.height = this.height;
		const context = this.canvas.getContext('2d', { alpha: false });
		if (!context) {
			throw new Error('Unable to initialize call recording canvas.');
		}
		this.context = context;
		this.stream = this.canvas.captureStream(this.frameRate);
	}

	start(): void {
		if (this.renderInterval !== null) return;
		this.renderInterval = setInterval(() => {
			this.drawFrame();
		}, Math.max(24, Math.round(1000 / this.frameRate)));
		this.drawFrame();
	}

	sync(snapshot: CallRecordingSnapshot): void {
		const participants = buildParticipants(
			snapshot.activeCalls,
			snapshot.isInCall,
			snapshot.localStream,
			snapshot.isVideoOff
		);
		const shares = buildShares(snapshot.screenShares, snapshot.isSharing, snapshot.localScreenStream);
		const renderTiles = buildRenderTiles(participants, shares);
		const tileById = new Map(renderTiles.map((tile) => [tile.id, tile]));
		const activeSpeakerLevels = buildActiveSpeakerLevels(
			participants,
			snapshot.activeCalls,
			snapshot.isLocalSpeaking,
			snapshot.isMuted,
			false
		);
		const layoutResult = computeCallLayout({
			participants: participants.map((participant) => ({
				id: participant.id,
				hasVideo: participant.hasVideo
			})),
			shares: shares.map((share) => ({
				id: share.id,
				participantId: share.participantId
			})),
			pins: [],
			activeSpeakerLevels,
			nowMs: Date.now(),
			activeSpeakerState: this.activeSpeakerState
		});
		this.activeSpeakerState = layoutResult.nextActiveSpeakerState;
		this.heroTileIds = [...layoutResult.heroIds];
		this.orderedTiles = layoutResult.tileIds
			.map((tileId) => tileById.get(tileId))
			.filter((tile): tile is RenderTile => Boolean(tile));
		this.syncVideoElements();
	}

	getStream(): MediaStream {
		return this.stream;
	}

	private syncVideoElements(): void {
		const desired = new Map<string, MediaStream>();
		for (const tile of this.orderedTiles) {
			if (tile.kind === 'avatar' || !tile.stream) continue;
			if (!tile.stream.getVideoTracks().length) continue;
			desired.set(tile.id, tile.stream);
		}

		for (const [tileId, video] of this.videoElements.entries()) {
			if (desired.has(tileId)) continue;
			video.pause();
			video.srcObject = null;
			this.videoElements.delete(tileId);
		}

		for (const [tileId, stream] of desired.entries()) {
			const existing = this.videoElements.get(tileId);
			if (existing) {
				if (existing.srcObject !== stream) {
					existing.srcObject = stream;
					void existing.play().catch(() => undefined);
				}
				continue;
			}
			const video = document.createElement('video');
			video.autoplay = true;
			video.muted = true;
			video.playsInline = true;
			video.srcObject = stream;
			void video.play().catch(() => undefined);
			this.videoElements.set(tileId, video);
		}
	}

	private computeRects(): TileRect[] {
		const tiles = this.orderedTiles;
		if (tiles.length === 0) return [];
		const heroSet = new Set(this.heroTileIds);
		const heroes = tiles.filter((tile) => heroSet.has(tile.id));
		const secondary = tiles.filter((tile) => !heroSet.has(tile.id));

		if (heroes.length === 1) {
			const secondaryHeight = secondary.length > 0 ? Math.min(180, Math.max(104, Math.floor(this.height * 0.22))) : 0;
			const rects: TileRect[] = [
				{
					tile: heroes[0],
					x: 0,
					y: 0,
					width: this.width,
					height: this.height - secondaryHeight
				}
			];
			if (secondaryHeight > 0) {
				const gap = 12;
				const totalGap = gap * Math.max(0, secondary.length - 1);
				const secondaryWidth = Math.max(160, Math.floor((this.width - totalGap) / secondary.length));
				secondary.forEach((tile, index) => {
					rects.push({
						tile,
						x: index * (secondaryWidth + gap),
						y: this.height - secondaryHeight,
						width: secondaryWidth,
						height: secondaryHeight
					});
				});
			}
			return rects;
		}

		if (heroes.length >= 2) {
			const heroHeight = secondary.length > 0 ? Math.floor(this.height * 0.72) : this.height;
			const heroWidth = Math.floor((this.width - 12) / 2);
			const rects: TileRect[] = heroes.slice(0, 2).map((tile, index) => ({
				tile,
				x: index * (heroWidth + 12),
				y: 0,
				width: heroWidth,
				height: heroHeight
			}));
			if (secondary.length > 0) {
				const secondaryY = heroHeight + 12;
				const secondaryHeight = this.height - secondaryY;
				const gap = 12;
				const totalGap = gap * Math.max(0, secondary.length - 1);
				const secondaryWidth = Math.max(140, Math.floor((this.width - totalGap) / secondary.length));
				secondary.forEach((tile, index) => {
					rects.push({
						tile,
						x: index * (secondaryWidth + gap),
						y: secondaryY,
						width: secondaryWidth,
						height: secondaryHeight
					});
				});
			}
			return rects;
		}

		return this.computeGridRects(tiles);
	}

	private computeGridRects(tiles: RenderTile[]): TileRect[] {
		const count = tiles.length;
		const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
		const rows = Math.max(1, Math.ceil(count / columns));
		const gap = 12;
		const tileWidth = Math.floor((this.width - gap * (columns - 1)) / columns);
		const tileHeight = Math.floor((this.height - gap * (rows - 1)) / rows);
		return tiles.map((tile, index) => {
			const column = index % columns;
			const row = Math.floor(index / columns);
			return {
				tile,
				x: column * (tileWidth + gap),
				y: row * (tileHeight + gap),
				width: tileWidth,
				height: tileHeight
			};
		});
	}

	private drawFrame(): void {
		const ctx = this.context;
		ctx.fillStyle = '#0b1018';
		ctx.fillRect(0, 0, this.width, this.height);

		if (this.orderedTiles.length === 0) {
			this.drawEmptyState();
			return;
		}

		for (const rect of this.computeRects()) {
			this.drawTile(rect);
		}
	}

	private drawEmptyState(): void {
		const ctx = this.context;
		ctx.fillStyle = '#121a27';
		ctx.fillRect(0, 0, this.width, this.height);
		ctx.fillStyle = '#f8fafc';
		ctx.font = '600 42px sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText('Call recording', this.width / 2, this.height / 2 - 18);
		ctx.font = '400 24px sans-serif';
		ctx.fillStyle = '#94a3b8';
		ctx.fillText('Waiting for active media', this.width / 2, this.height / 2 + 28);
	}

	private drawTile(rect: TileRect): void {
		const { tile, x, y, width, height } = rect;
		const ctx = this.context;
		const radius = 18;
		ctx.save();
		this.roundRectPath(ctx, x, y, width, height, radius);
		ctx.clip();
		ctx.fillStyle = '#111827';
		ctx.fillRect(x, y, width, height);

		const video = this.videoElements.get(tile.id);
		if (video && video.readyState >= 2) {
			this.drawVideo(video, x, y, width, height, tile.kind === 'screen' ? 'contain' : 'cover');
		} else {
			this.drawAvatarCard(tile, x, y, width, height);
		}

		this.drawTileLabel(tile.label, x, y, width, height);
		ctx.restore();
	}

	private drawVideo(
		video: HTMLVideoElement,
		x: number,
		y: number,
		width: number,
		height: number,
		fit: 'cover' | 'contain'
	): void {
		const ctx = this.context;
		const sourceWidth = video.videoWidth || width;
		const sourceHeight = video.videoHeight || height;
		const sourceRatio = sourceWidth / sourceHeight;
		const destRatio = width / height;
		let drawWidth = width;
		let drawHeight = height;
		let drawX = x;
		let drawY = y;

		if ((fit === 'cover' && sourceRatio > destRatio) || (fit === 'contain' && sourceRatio < destRatio)) {
			drawWidth = height * sourceRatio;
			drawX = x - (drawWidth - width) / 2;
		} else {
			drawHeight = width / sourceRatio;
			drawY = y - (drawHeight - height) / 2;
		}

		ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
	}

	private drawAvatarCard(tile: RenderTile, x: number, y: number, width: number, height: number): void {
		const ctx = this.context;
		const baseColor = colorFromLabel(tile.label);
		ctx.fillStyle = baseColor;
		ctx.fillRect(x, y, width, height);
		ctx.fillStyle = 'rgba(15, 23, 42, 0.18)';
		ctx.fillRect(x, y, width, height);

		const circleSize = Math.min(width, height) * 0.34;
		const circleX = x + width / 2;
		const circleY = y + height / 2 - 16;
		ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
		ctx.beginPath();
		ctx.arc(circleX, circleY, circleSize / 2, 0, Math.PI * 2);
		ctx.fill();

		ctx.fillStyle = '#ffffff';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.font = `700 ${Math.max(26, Math.floor(circleSize * 0.44))}px sans-serif`;
		ctx.fillText(getInitial(tile.label), circleX, circleY + 2);
	}

	private drawTileLabel(label: string, x: number, y: number, width: number, height: number): void {
		const ctx = this.context;
		const labelHeight = 34;
		ctx.fillStyle = 'rgba(2, 6, 23, 0.66)';
		ctx.fillRect(x, y + height - labelHeight, width, labelHeight);
		ctx.fillStyle = '#f8fafc';
		ctx.font = '600 16px sans-serif';
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';
		ctx.fillText(label, x + 14, y + height - labelHeight / 2);
	}

	private roundRectPath(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		width: number,
		height: number,
		radius: number
	): void {
		const r = Math.min(radius, width / 2, height / 2);
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + width, y, x + width, y + height, r);
		ctx.arcTo(x + width, y + height, x, y + height, r);
		ctx.arcTo(x, y + height, x, y, r);
		ctx.arcTo(x, y, x + width, y, r);
		ctx.closePath();
	}

	dispose(): void {
		if (this.renderInterval !== null) {
			clearInterval(this.renderInterval);
			this.renderInterval = null;
		}
		for (const video of this.videoElements.values()) {
			video.pause();
			video.srcObject = null;
		}
		this.videoElements.clear();
		for (const track of this.stream.getTracks()) {
			track.stop();
		}
	}
}
