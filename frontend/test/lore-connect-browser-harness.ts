import { mount } from 'svelte';
import '../src/styles/styles.css';
import Harness from './LoreConnectHarness.svelte';

const harness = mount(Harness, { target: document.getElementById('harness')! });
(window as any).__loreConnect = { selectChannel: harness.selectChannel };
