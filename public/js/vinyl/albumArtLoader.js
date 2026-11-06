/**
 * Streams album covers into the record texture array in the background.
 * Records show a placeholder label until their cover arrives, so the room appears
 * immediately however large the library is. A cover that fails keeps the placeholder.
 */

const CONCURRENCY = 12;
const FLUSH_INTERVAL_S = 0.4;

export class AlbumArtLoader {
  #layered;
  #queue;
  #canvas;
  #ctx;
  #sinceFlush = 0;

  /**
   * @param {import('../scene/layeredTexture.js').LayeredTexture} layered
   * @param {Map<string, number>} layerByUrl image URL to texture layer
   */
  constructor(layered, layerByUrl) {
    this.#layered = layered;
    this.#queue = [...layerByUrl.entries()].reverse(); // reversed because we pop from the end
    this.#canvas = document.createElement('canvas');
    this.#canvas.width = layered.width;
    this.#canvas.height = layered.height;
    this.#ctx = this.#canvas.getContext('2d', { willReadFrequently: true });
    this.#ctx.imageSmoothingQuality = 'high'; // covers are downloaded larger than they're stored

    for (let i = 0; i < CONCURRENCY; i++) this.#runWorker();
  }

  /**
   * Regenerating mipmaps touches the whole texture, so uploads are batched rather
   * than sent per cover. Returns true when new art went to the GPU.
   */
  update(deltaSeconds) {
    this.#sinceFlush += deltaSeconds;
    if (this.#sinceFlush < FLUSH_INTERVAL_S) return false;
    this.#sinceFlush = 0;
    return this.#layered.flush();
  }

  async #runWorker() {
    while (this.#queue.length > 0) {
      const [url, layer] = this.#queue.pop();
      try {
        const image = new Image();
        image.crossOrigin = 'anonymous'; // without this the canvas can't read the pixels
        image.src = url;
        await image.decode();
        const { width, height } = this.#canvas;
        this.#ctx.drawImage(image, 0, 0, width, height);
        this.#layered.writeLayer(layer, this.#ctx.getImageData(0, 0, width, height).data);
      } catch (error) {
        console.debug('Album art failed to load:', error.message);
      }
    }
  }
}
