export interface Album {
    id: string;
    name: string;
    coverUrl?: string;
    photoCount: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface Photo {
    id: string;
    albumId: string;
    url: string;
    thumbnailUrl: string;
    width: number;
    height: number;
    caption?: string;
    uploadedAt: Date;
}

export interface AlbumService {
    createAlbum(name: string): Promise<Album>;
    getAlbum(id: string): Promise<Album | null>;
    listAlbums(): Promise<Album[]>;
    addPhoto(albumId: string, photo: Photo): Promise<Photo>;
    removePhoto(albumId: string, photoId: string): Promise<void>;
}