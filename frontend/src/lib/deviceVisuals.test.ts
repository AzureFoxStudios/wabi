import { expect, test } from 'bun:test';
import { deviceVisual } from './deviceVisuals';

test('audio device hints distinguish headsets, speakers and microphones', () => {
	expect(deviceVisual('audioinput', 'USB Headset Microphone')).toBe('headset');
	expect(deviceVisual('audiooutput', 'Built-in Output')).toBe('speaker');
	expect(deviceVisual('audioinput', 'Studio USB Mic')).toBe('microphone');
	expect(deviceVisual('videoinput', 'Webcam')).toBe('camera');
});
