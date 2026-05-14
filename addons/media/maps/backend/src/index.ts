export interface MapLocation {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    description?: string;
}

export interface MapMarker {
    id: string;
    location: MapLocation;
    ownerId: string;
    createdAt: Date;
}

export interface MapService {
    createMarker(location: MapLocation, ownerId: string): Promise<MapMarker>;
    getMarker(id: string): Promise<MapMarker | null>;
    listMarkers(userId: string): Promise<MapMarker[]>;
    deleteMarker(id: string): Promise<void>;
}