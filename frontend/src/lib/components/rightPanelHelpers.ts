import type { WorkspacePanelManifest } from '$lib/workspacePanels';
import type { WorkspacePanelStackV1 } from '$lib/docking/layoutSchema';

export interface RenderStack extends WorkspacePanelStackV1 {
	panels: WorkspacePanelManifest[];
	activePanel: WorkspacePanelManifest;
	overflowPanels: WorkspacePanelManifest[];
	visiblePanels: WorkspacePanelManifest[];
}

export function buildRenderStacks(
	stacks: WorkspacePanelStackV1[],
	registry: Map<string, WorkspacePanelManifest>,
	overflowThreshold: number
): RenderStack[] {
	return stacks
		.map((stack) => {
			const panels = stack.tabs
				.map((panelId) => registry.get(panelId))
				.filter((panel): panel is WorkspacePanelManifest => Boolean(panel));
			if (panels.length === 0) return null;
			const activePanel = panels.find((panel) => panel.id === stack.activePanelId) || panels[0];
			const threshold = Math.max(3, Math.min(overflowThreshold || 5, 8));
			const visiblePanels = panels.slice(0, threshold);
			const overflowPanels = panels.slice(threshold);
			return { ...stack, panels, activePanel, visiblePanels, overflowPanels };
		})
		.filter((stack): stack is RenderStack => Boolean(stack));
}

export function buildMobileRenderStack(
	panels: WorkspacePanelManifest[],
	currentPanel: WorkspacePanelManifest | null,
	overflowThreshold: number
): RenderStack[] {
	if (panels.length === 0) return [];
	const active = currentPanel && panels.some((panel) => panel.id === currentPanel.id) ? currentPanel : panels[0];
	const threshold = Math.max(4, Math.min(overflowThreshold || 5, 8));
	return [
		{
			id: 'mobile-stack',
			tabs: panels.map((panel) => panel.id),
			activePanelId: active.id,
			size: 100,
			minSize: 100,
			maxSize: 100,
			collapsed: false,
			pinned: true,
			panels,
			activePanel: active,
			visiblePanels: panels.slice(0, threshold),
			overflowPanels: panels.slice(threshold)
		}
	];
}

export function formatWorkspaceName(name: string): string {
	if (name === 'media-review') return 'Media Review';
	return name
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

export function handleTabKeydown(
	event: KeyboardEvent,
	stack: RenderStack,
	panel: WorkspacePanelManifest,
	setActiveRightPanel: (id: string) => void,
	splitPanel: (id: string) => void
): void {
	const currentIndex = stack.panels.findIndex((candidate) => candidate.id === panel.id);
	if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
		event.preventDefault();
		const next = stack.panels[(currentIndex + 1) % stack.panels.length];
		setActiveRightPanel(next.id);
	}
	if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
		event.preventDefault();
		const previous = stack.panels[(currentIndex - 1 + stack.panels.length) % stack.panels.length];
		setActiveRightPanel(previous.id);
	}
	if (event.key === 'Enter' || event.key === ' ') {
		event.preventDefault();
		setActiveRightPanel(panel.id);
	}
	if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) {
		event.preventDefault();
		splitPanel(panel.id);
	}
}

export interface DragPayload {
	panelId: string;
	stackId: string;
}

export function handleDragStart(event: DragEvent, stackId: string, panelId: string): string {
	event.dataTransfer?.setData('text/plain', JSON.stringify({ panelId, stackId }));
	if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
	return panelId;
}

export function handleDragOver(event: DragEvent): void {
	event.preventDefault();
	if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}

export function parseDragPayload(dataTransfer: DataTransfer | null): DragPayload | null {
	try {
		const payload = JSON.parse(dataTransfer?.getData('text/plain') || '{}') as DragPayload;
		if (payload.panelId && payload.stackId) return payload;
	} catch {
		// no-op
	}
	return null;
}

export function getSplitOrientation(orientation: string): 'horizontal' | 'vertical' {
	return orientation === 'horizontal' ? 'horizontal' : 'vertical';
}

export function computeResizeSize(event: MouseEvent, dockElement: HTMLElement, isHorizontalSplit: boolean): number {
	const rect = dockElement.getBoundingClientRect();
	if (isHorizontalSplit) {
		return ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 100;
	}
	return ((event.clientY - rect.top) / Math.max(rect.height, 1)) * 100;
}
