import {mount} from 'svelte';
import '../src/styles/styles.css';
import Connections from '../src/lib/components/ProjectConnections.svelte';
import Assistant from '../src/lib/components/ProjectAssistant.svelte';
import {darkTheme} from '../src/lib/theme/themes';
import {applyTheme} from '../src/lib/theme/themeManager';
applyTheme(darkTheme);
mount(new URL(location.href).searchParams.get('view')==='assistant'?Assistant:Connections,{target:document.getElementById('harness')!,props:{channelId:'ch_test'}});
