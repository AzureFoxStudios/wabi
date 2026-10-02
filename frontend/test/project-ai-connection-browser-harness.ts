import { mount } from 'svelte';
import '../src/styles/styles.css';
import Connection from '../src/lib/components/ProjectAIConnection.svelte';
import { darkTheme } from '../src/lib/theme/themes';
import { applyTheme } from '../src/lib/theme/themeManager';
applyTheme(darkTheme);
mount(Connection, { target: document.getElementById('harness')!, props: { channelId: 'ch_test' } });
