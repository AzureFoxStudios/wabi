#!/usr/bin/env node

import { spawn } from 'child_process';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv);
const sessionId = args['session-id'] || process.env.WABI_SESSION_ID || 'unknown';
const publishUrl = args['publish-url'] || process.env.WABI_PUBLISH_URL;
const playbackUrl = args['playback-url'] || process.env.WABI_PLAYBACK_URL;
const ffmpegBin = process.env.MEDIA_GATEWAY_FFMPEG_BIN || 'ffmpeg';
const profile = (process.env.MEDIA_GATEWAY_FFMPEG_PROFILE || 'copy').toLowerCase();
const videoBitrate = process.env.MEDIA_GATEWAY_FFMPEG_VIDEO_BITRATE || '12000k';
const audioBitrate = process.env.MEDIA_GATEWAY_FFMPEG_AUDIO_BITRATE || '192k';
const gop = process.env.MEDIA_GATEWAY_FFMPEG_GOP || '120';
const fps = process.env.MEDIA_GATEWAY_FFMPEG_FPS || '60';
const preset = process.env.MEDIA_GATEWAY_FFMPEG_PRESET || 'slow';
const tune = process.env.MEDIA_GATEWAY_FFMPEG_TUNE || 'zerolatency';

if (!publishUrl || !playbackUrl) {
  console.error('[ffmpeg-srt-bridge] Missing publish/playback URL');
  process.exit(2);
}

function buildCopyArgs() {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    process.env.MEDIA_GATEWAY_FFMPEG_LOGLEVEL || 'warning',
    '-fflags',
    'nobuffer',
    '-i',
    publishUrl,
    '-map',
    '0:v?',
    '-map',
    '0:a?',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-f',
    process.env.MEDIA_GATEWAY_FFMPEG_MUX || 'mpegts',
    playbackUrl
  ];
}

function buildRealtimeTranscodeArgs() {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    process.env.MEDIA_GATEWAY_FFMPEG_LOGLEVEL || 'warning',
    '-fflags',
    'nobuffer',
    '-i',
    publishUrl,
    '-map',
    '0:v?',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-r',
    fps,
    '-g',
    gop,
    '-b:v',
    videoBitrate,
    '-maxrate',
    videoBitrate,
    '-bufsize',
    String(parseInt(videoBitrate, 10) * 2) + 'k',
    '-c:a',
    'aac',
    '-b:a',
    audioBitrate,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-f',
    process.env.MEDIA_GATEWAY_FFMPEG_MUX || 'mpegts',
    playbackUrl
  ];
}

function buildHighQualityTranscodeArgs() {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    process.env.MEDIA_GATEWAY_FFMPEG_LOGLEVEL || 'warning',
    '-i',
    publishUrl,
    '-map',
    '0:v?',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-tune',
    tune,
    '-r',
    fps,
    '-g',
    gop,
    '-b:v',
    videoBitrate,
    '-maxrate',
    videoBitrate,
    '-bufsize',
    String(parseInt(videoBitrate, 10) * 3) + 'k',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    audioBitrate,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-f',
    process.env.MEDIA_GATEWAY_FFMPEG_MUX || 'mpegts',
    playbackUrl
  ];
}

let ffmpegArgs;
if (profile === 'copy') {
  ffmpegArgs = buildCopyArgs();
} else if (profile === 'realtime') {
  ffmpegArgs = buildRealtimeTranscodeArgs();
} else if (profile === 'hq') {
  ffmpegArgs = buildHighQualityTranscodeArgs();
} else {
  console.error(`[ffmpeg-srt-bridge] Unknown MEDIA_GATEWAY_FFMPEG_PROFILE '${profile}'. Use: copy | realtime | hq`);
  process.exit(2);
}

console.log(`[ffmpeg-srt-bridge] session=${sessionId}`);
console.log(`[ffmpeg-srt-bridge] profile=${profile}`);
console.log(`[ffmpeg-srt-bridge] ${ffmpegBin} ${ffmpegArgs.join(' ')}`);

const child = spawn(ffmpegBin, ffmpegArgs, {
  stdio: 'inherit',
  shell: false,
  windowsHide: true
});

let exiting = false;
function shutdown(signal) {
  if (exiting) return;
  exiting = true;
  try {
    child.kill(signal || 'SIGTERM');
  } catch {
    // no-op
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    console.warn(`[ffmpeg-srt-bridge] ffmpeg exited by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code == null ? 1 : code);
});

child.on('error', (error) => {
  console.error('[ffmpeg-srt-bridge] Failed to start ffmpeg:', error.message);
  process.exit(1);
});
