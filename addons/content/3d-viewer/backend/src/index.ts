export type ModelFormat = 'obj' | 'gltf' | 'glb' | 'fbx';

export interface Model3D {
    id: string;
    name: string;
    format: ModelFormat;
    url: string;
    thumbnailUrl?: string;
}

export interface ViewerSettings {
    backgroundColor: string;
    showGrid: boolean;
    autoRotate: boolean;
    zoomLevel: number;
}

export function createDefaultSettings(): ViewerSettings {
    return {
        backgroundColor: '#1a1a1a',
        showGrid: true,
        autoRotate: false,
        zoomLevel: 1,
    };
}