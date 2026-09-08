import { mount } from 'svelte';
import '../src/styles/styles.css';
import MessageDeliveryFixture from './MessageDeliveryFixture.svelte';
import { applyTheme } from '../src/lib/theme/themeManager';
import { darkTheme, lightTheme } from '../src/lib/theme/themes';

applyTheme(darkTheme);
const fixture = mount(MessageDeliveryFixture, { target: document.getElementById('harness')! });
(window as any).__deliveryRows = {
	setDelivery: fixture.setDelivery,
	setTheme: (theme: string) => applyTheme(theme === 'light' ? lightTheme : darkTheme)
};
