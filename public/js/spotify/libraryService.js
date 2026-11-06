/**
 * Loads the user's playlists and songs and converts them into the app's own
 * plain data model, so Spotify's response format stays contained in this file.
 *
 * API notes (February 2026 changes):
 * - Songs come from GET /playlists/{id}/items, each under `item`. `track` is the older
 *   name, which Extended Quota apps may still receive, so both are read.
 * - Development Mode apps only get songs for playlists the user owns or collaborates
 *   on. Others answer 403 and are shown as an empty shelf, marked `restricted`.
 */

import { SpotifyApiError } from './apiClient.js';

const PLAYLIST_PAGE_SIZE = 50;
const ITEM_PAGE_SIZE = 50; // API maximum
const PLAYLIST_CONCURRENCY = 4;

const TRACK_FIELDS =
  'type,uri,id,name,duration_ms,is_local,artists(name),album(name,release_date,release_date_precision,images(url,width,height))';
// Asking for only what we use keeps a 500-song playlist's ten pages small.
const ITEM_FIELDS = `next,items(item(${TRACK_FIELDS}),track(${TRACK_FIELDS}))`;

/** @typedef {'ok'|'restricted'|'failed'} PlaylistStatus */

/** Spotify lists images largest first, but the order isn't guaranteed. */
function pickArtwork(images = []) {
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const thumbnail = sorted.find((image) => (image.width ?? 0) >= 64) ?? sorted.at(-1);
  return { thumbUrl: thumbnail?.url ?? null, fullUrl: sorted.at(-1)?.url ?? null };
}

/** @returns the app's song model, or null for anything that isn't a song (such as an episode) */
export function mapPlaylistEntry(entry) {
  const track = entry?.item ?? entry?.track;
  if (!track || track.type !== 'track') return null;

  const artwork = pickArtwork(track.album?.images);
  return {
    uri: track.uri,
    title: track.name || 'Unknown title',
    artists: (track.artists ?? []).map((artist) => artist.name).filter(Boolean),
    album: track.album?.name || 'Unknown album',
    durationMs: track.duration_ms ?? 0,
    releaseDate: track.album?.release_date ?? null,
    releaseDatePrecision: track.album?.release_date_precision ?? 'day',
    artThumbUrl: artwork.thumbUrl,
    artFullUrl: artwork.fullUrl,
    // Local files have no Spotify audio, so they can be shown but not played.
    isLocal: Boolean(track.is_local),
  };
}

function mapPlaylist(raw) {
  return {
    id: raw.id,
    uri: raw.uri,
    name: raw.name || 'Untitled playlist',
    tracks: [],
    /** @type {PlaylistStatus} */
    status: 'ok',
  };
}

async function fetchAllPlaylists(api) {
  const playlists = [];
  let url = `/me/playlists?limit=${PLAYLIST_PAGE_SIZE}`;
  while (url) {
    const page = await api.get(url);
    // The API occasionally returns null entries for playlists that no longer exist.
    playlists.push(...page.items.filter(Boolean).map(mapPlaylist));
    url = page.next;
  }
  return playlists;
}

async function fetchPlaylistTracks(api, playlistId) {
  const tracks = [];
  const fields = encodeURIComponent(ITEM_FIELDS);
  let url = `/playlists/${playlistId}/items?limit=${ITEM_PAGE_SIZE}&additional_types=track&fields=${fields}`;
  while (url) {
    const page = await api.get(url);
    for (const entry of page.items) {
      const track = mapPlaylistEntry(entry);
      if (track) tracks.push(track);
    }
    url = page.next;
  }
  return tracks;
}

/**
 * Runs `worker` over items with limited concurrency, staying gentle on the rate limit.
 */
async function forEachLimited(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await worker(items[next++]);
    }
  });
  await Promise.all(runners);
}

/**
 * Retrieves every playlist and its songs. A failure on one playlist is recorded on
 * that playlist and doesn't stop the others; failing to list playlists does throw.
 *
 * @param {import('./apiClient.js').SpotifyApiClient} api
 * @param {(loaded: number, total: number) => void} [onProgress]
 */
export async function fetchLibrary(api, onProgress = () => {}) {
  const playlists = await fetchAllPlaylists(api);
  let loaded = 0;
  onProgress(loaded, playlists.length);

  await forEachLimited(playlists, PLAYLIST_CONCURRENCY, async (playlist) => {
    try {
      playlist.tracks = await fetchPlaylistTracks(api, playlist.id);
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 403) {
        playlist.status = 'restricted';
      } else if (error instanceof SpotifyApiError) {
        console.warn(`Could not load playlist "${playlist.name}":`, error.message);
        playlist.status = 'failed';
      } else {
        // Not an API response, such as an expired session: let the app handle it.
        throw error;
      }
    }
    onProgress(++loaded, playlists.length);
  });

  return playlists;
}
