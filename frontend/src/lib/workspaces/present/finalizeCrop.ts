import { cleanSceneObject, type SceneObject } from '../scene';

/** Replace the visible crop with new pixel data; CSS clipping alone is not redaction. */
export async function finalizeCrop(source: SceneObject, aspect: number, signal: AbortSignal): Promise<string> {
    const object = cleanSceneObject(source);
    if (!object.image || object.kind !== 'image' || !Number.isFinite(aspect) || aspect < .5 || aspect > 3) throw new Error('Choose a valid image object to finalize.');
    signal.throwIfAborted();
    const image = new Image();
    const cancel = () => { image.src = ''; };
    signal.addEventListener('abort', cancel, { once: true });
    const canvas = document.createElement('canvas');
    try {
        image.src = object.image; await image.decode(); signal.throwIfAborted();
        if (image.naturalWidth * image.naturalHeight > 32_000_000) throw new Error('Image dimensions exceed the crop limit.');
        canvas.width = Math.max(1, Math.round(object.w * 1400));
        canvas.height = Math.max(1, Math.round(object.h * 1400 / aspect));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Image cropping is unavailable.');
        const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
        context.drawImage(image, (canvas.width - width) * object.cropX, (canvas.height - height) * object.cropY, width, height);
        signal.throwIfAborted();
        let result = canvas.toDataURL('image/png');
        if (result.length > 2 * 1024 * 1024) result = canvas.toDataURL('image/jpeg', .85);
        if (result.length > 2 * 1024 * 1024) throw new Error('The finalized crop exceeds the image size limit. Use a smaller source image.');
        return result;
    } finally {
        signal.removeEventListener('abort', cancel); image.src = ''; canvas.width = canvas.height = 1;
    }
}
