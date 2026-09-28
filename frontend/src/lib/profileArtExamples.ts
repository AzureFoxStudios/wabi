import type { EditableUsernameFont } from './profileDesign';

export type ProfileArtExample = {
	id: string;
	title: string;
	description: string;
	banner: string;
	still: string;
	canvas: string;
	animation?: string;
	gif?: string;
	source?: string;
	nameFile: string;
	usernameFont: EditableUsernameFont;
};

const directory = '/profile-art/examples';

export const PROFILE_ART_EXAMPLES: ProfileArtExample[] = [
	{
		id: 'night-garden', title: 'Night Garden',
		description: 'Painted moonlight, a violet name gradient and an outlined plate.',
		banner: `${directory}/night-garden.png`, still: `${directory}/night-garden.png`,
		canvas: '2172 × 724 · 3:1 · PNG', nameFile: `${directory}/night-garden.wabi-profile.json`,
		usernameFont: {
			family: 'Georgia', size: '1em', weight: '600', style: 'normal', preset: 'none',
			design: { effect: 'gradient', color: '#DDD6FE', color2: '#99F6E4', angle: 110, glow: 1, animationSeconds: 8, plate: 'outline', plateColor: '#A78BFA', plateColor2: '#5EEAD4', plateOpacity: 0.65 }
		}
	},
	{
		id: 'aurora-loop', title: 'Aurora Loop',
		description: 'A gentle ribbon loop with glowing lettering and a subtle gradient plate.',
		banner: `${directory}/aurora-loop.webp`, still: `${directory}/aurora-loop-poster.png`,
		canvas: '1200 × 400 · 3:1', animation: '4-second loop · 16 fps',
		gif: `${directory}/aurora-loop.gif`, source: `${directory}/aurora-loop.py`,
		nameFile: `${directory}/aurora-loop.wabi-profile.json`,
		usernameFont: {
			family: 'inherit', size: '1em', weight: '700', style: 'normal', preset: 'none',
			design: { effect: 'glow', color: '#C4B5FD', color2: '#A5F3FC', angle: 105, glow: 3, animationSeconds: 8, plate: 'gradient', plateColor: '#312E81', plateColor2: '#164E63', plateOpacity: 0.45 }
		}
	}
];
