export type FloatingPanelKind = 'channel-chat' | 'server-map' | 'workspace-panel';

export type FloatingPanelMode = 'floating' | 'docked' | 'maximized' | 'minimized';

export type SnapZone =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'maximize';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingPanelPayload {
  channelId?: string;
  channelName?: string;
  placeId?: string;
  panelId?: string;
}

export interface FloatingPanelState {
  id: string;
  kind: FloatingPanelKind;
  title: string;
  payload: FloatingPanelPayload;
  mode: FloatingPanelMode;
  rect: Rect;
  previousRect?: Rect;
  snapZone?: SnapZone;
  zIndex: number;
}

export interface FloatingPanelOptions {
  kind: FloatingPanelKind;
  title?: string;
  payload?: FloatingPanelPayload;
  rect?: Partial<Rect>;
}