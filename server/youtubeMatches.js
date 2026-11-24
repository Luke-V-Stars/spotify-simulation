/**
 * Finds the YouTube video to play for a song, using the YouTube Data API.
 *
 * Searching is expensive: a project's default quota allows about 100 searches a day.
 * So the server searches only when a song is played, never for a whole library, and
 * remembers every answer on disk, so each song costs one search however often it's played.
 * Checking durations costs 1 unit, so it's always worth it: it puts the studio version
 * ahead of live recordings and long music videos.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

const SEARCH_RESULTS = 8;
const MAX_CANDIDATES = 5;
const MAX_TEXT_LENGTH = 300;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** How close a video's length must be to the song's to count as the same recording. */
const CLOSE_MATCH_MS = 10_000;
const LOOSE_MATCH_MS = 45_000;

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // videos get taken down, so look again eventually
const MAX_CACHE_ENTRIES = 20_000;
const SAVE_DELAY_MS = 1000;

/** A failure with a status and a message safe to show the user. */
export class YouTubeMatchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The search text for a song. Remaster notes are left out: they describe the release,
 * and the uploads that match the song best rarely mention them.
 */
export function searchQuery(title, artist) {
  const cleanTitle = title
    .replace(/\s*[([][^)\]]*remaster[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+[^-]*remaster.*$/i, '')
    .trim();
  return [artist, cleanTitle].filter(Boolean).join(' ');
}

/** Converts an ISO 8601 duration such as PT4M13S to milliseconds, or null if it isn't one. */
export function parseIsoDuration(text) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text ?? '');
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match.map((part) => Number(part ?? 0));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * Orders videos by how closely their length matches the song's, keeping YouTube's own
 * relevance order within each band. Videos of unknown length go last.
 */
export function rankByDuration(videos, durationMs) {
  if (!durationMs) return videos;
  const band = ({ durationMs: videoMs }) => {
    if (videoMs == null) return 3;
    const difference = Math.abs(videoMs - durationMs);
    if (difference <= CLOSE_MATCH_MS) return 0;
    if (difference <= LOOSE_MATCH_MS) return 1;
    return 2;
  };
  return videos
    .map((video, order) => ({ video, order, band: band(video) }))
    .sort((a, b) => a.band - b.band || a.order - b.order)
    .map(({ video }) => video);
}

/** Turns a YouTube API error into a message for the user. The API key is never included. */
async function apiError(response) {
  const body = await response.json().catch(() => ({}));
  const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? `HTTP ${response.status}`;
  console.error('YouTube API request failed:', reason);
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return new YouTubeMatchError(
      429,
      'YouTube\'s daily search limit for this app has been reached. It resets at midnight Pacific time.',
    );
  }
  if (reason === 'keyInvalid' || reason === 'API_KEY_INVALID') {
    return new YouTubeMatchError(502, 'YouTube rejected the server\'s API key. Check YOUTUBE_API_KEY in .env.');
  }
  if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED') {
    return new YouTubeMatchError(
      502,
      'The YouTube Data API isn\'t enabled for this API key\'s Google Cloud project.',
    );
  }
  return new YouTubeMatchError(502, 'YouTube search failed. Try again in a moment.');
}

/**
 * Remembers matches in memory, and in a JSON file when given a path, so they survive
 * restarts. The file is rewritten shortly after a change rather than on every change.
 */
export class MatchCache {
  #filePath;
  #entries = new Map();
  #loaded;
  #saveTimer = null;

  /** @param {{filePath: string|null, now?: () => number}} options */
  constructor({ filePath, now = Date.now }) {
    this.#filePath = filePath;
    this.now = now;
    this.#loaded = filePath ? this.#load() : Promise.resolve();
  }

  async get(key) {
    await this.#loaded;
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.savedAt > CACHE_TTL_MS) {
      this.#entries.delete(key);
      return null;
    }
    return entry.videos;
  }

  async set(key, videos) {
    await this.#loaded;
    this.#entries.delete(key); // re-adding moves it to the end, so the oldest are dropped first
    this.#entries.set(key, { videos, savedAt: this.now() });
    while (this.#entries.size > MAX_CACHE_ENTRIES) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
    this.#scheduleSave();
  }

  async #load() {
    try {
      const saved = JSON.parse(await readFile(this.#filePath, 'utf8'));
      for (const [key, entry] of Object.entries(saved)) this.#entries.set(key, entry);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Ignoring unreadable YouTube match cache:', error.message);
    }
  }

  #scheduleSave() {
    if (!this.#filePath || this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#save().catch((error) => console.warn('Could not save the YouTube match cache:', error.message));
    }, SAVE_DELAY_MS);
    this.#saveTimer.unref?.(); // never keeps the process alive on its own
  }

  async #save() {
    await mkdir(dirname(this.#filePath), { recursive: true });
    // Written beside the real file and then swapped in, so a crash can't leave half a file.
    const temporary = `${this.#filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(Object.fromEntries(this.#entries)));
    await rename(temporary, this.#filePath);
  }
}

/**
 * @param {{youtubeApiKey: string|null}} config
 * @param {{cache: MatchCache, fetchImpl?: typeof fetch}} options
 */
export function createYouTubeMatcher(config, { cache, fetchImpl = fetch }) {
  /** Concurrent requests for the same song share one search. */
  const inFlight = new Map();

  async function search(query) {
    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      videoEmbeddable: 'true', // leaves out videos whose owners block playing them on other sites
      videoSyndicated: 'true', // and those that can only be played on youtube.com
      maxResults: String(SEARCH_RESULTS),
      q: query,
      fields: 'items(id/videoId,snippet(title,channelTitle))',
      key: config.youtubeApiKey,
    });
    const response = await fetchImpl(`${SEARCH_URL}?${params}`);
    if (!response.ok) throw await apiError(response);
    const body = await response.json();
    return (body.items ?? [])
      .filter((item) => item.id?.videoId)
      .map((item) => ({ id: item.id.videoId, title: item.snippet?.title ?? '', channel: item.snippet?.channelTitle ?? '' }));
  }

  /** Adds each video's length, and drops any that can no longer be embedded. */
  async function addDurations(videos) {
    if (videos.length === 0) return videos;
    const params = new URLSearchParams({
      part: 'contentDetails,status',
      id: videos.map((video) => video.id).join(','),
      fields: 'items(id,contentDetails/duration,status/embeddable)',
      key: config.youtubeApiKey,
    });
    const response = await fetchImpl(`${VIDEOS_URL}?${params}`);
    if (!response.ok) throw await apiError(response);
    const details = new Map(((await response.json()).items ?? []).map((item) => [item.id, item]));
    return videos
      .filter((video) => details.get(video.id)?.status?.embeddable !== false)
      .map((video) => ({ ...video, durationMs: parseIsoDuration(details.get(video.id)?.contentDetails?.duration) }));
  }

  /**
   * @param {{title: string, artist: string, durationMs: number|null}} song
   * @returns {Promise<Array<{id: string, title: string, channel: string, durationMs: number|null}>>} best first
   */
  return async function findVideos({ title, artist, durationMs }) {
    if (!config.youtubeApiKey) {
      throw new YouTubeMatchError(503, 'YouTube playback isn\'t set up on the server. Add YOUTUBE_API_KEY to .env.');
    }
    const key = `${artist}\n${title}`.toLowerCase();
    const cached = await cache.get(key);
    if (cached) return cached;

    if (!inFlight.has(key)) {
      const lookup = (async () => {
        const videos = await addDurations(await search(searchQuery(title, artist)));
        const best = rankByDuration(videos, durationMs).slice(0, MAX_CANDIDATES);
        await cache.set(key, best);
        return best;
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, lookup);
    }
    return inFlight.get(key);
  };
}

/** Reads and checks the song described in a /youtube/match query string. */
export function parseMatchQuery(searchParams) {
  const title = searchParams.get('title')?.trim() ?? '';
  const artist = searchParams.get('artist')?.trim() ?? '';
  const durationText = searchParams.get('durationMs');
  const durationMs = durationText ? Number(durationText) : null;

  if (!title || title.length > MAX_TEXT_LENGTH || artist.length > MAX_TEXT_LENGTH) return null;
  if (durationMs !== null && !(Number.isInteger(durationMs) && durationMs > 0 && durationMs <= MAX_DURATION_MS)) {
    return null;
  }
  return { title, artist, durationMs };
}
