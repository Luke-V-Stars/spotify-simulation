/**
 * Loads the user's playlists and songs and converts them into the app's own
 * plain data model, so Spotify's response format stays contained in this file.
 *
 * API notes (February 2026 changes):
 * - Songs come from GET /playlists/{id}/items, each under `item`. `track` is the older
 *   name, which Extended Quota apps may still receive, so both are read.
 * - Development Mode apps only get songs for playlists the user owns or collaborates
 *   on. Others answer 403 and are shown as an empty shelf, marked `restricted`.
 * - GET /recommendations is deprecated, so "Suggested For You" is built from search
 *   results instead: songs in the genres of the user's top artists, and other songs by
 *   those artists. It's a stand-in for Spotify's own personalised picks. Artist `genres`
 *   is marked deprecated too, so without it the shelf falls back to the artists alone.
 */

import { SpotifyApiError } from './apiClient.js';

const PLAYLIST_PAGE_SIZE = 50;
const ITEM_PAGE_SIZE = 50; // API maximum
const PLAYLIST_CONCURRENCY = 4;
const SHELF_ART_MIN_WIDTH = 128; // the size a cover is stored at on a sleeve

const SAVED_PAGE_SIZE = 50; // API maximum
const TOP_SONGS_COUNT = 50; // API maximum, and exactly one full shelf
const TOP_ARTIST_COUNT = 10;
const SEARCH_PAGE_SIZE = 10; // API maximum
const SEARCH_PAGES_PER_SOURCE = 2; // the first results are often songs the user already has
const SUGGESTION_GENRE_COUNT = 5;
const SUGGESTION_COUNT = 50; // one full shelf
const SEARCH_CONCURRENCY = 4;
const TIME_RANGE = 'medium_term'; // about the last 6 months

/** Identifies the shelf whose first songs hang on the wall as plaques. */
export const TOP_SONGS_ID = 'top-songs';

const TRACK_FIELDS =
  'type,uri,id,name,duration_ms,is_local,artists(name),album(name,release_date,release_date_precision,images(url,width,height))';
// Asking for only what we use keeps a 500-song playlist's ten pages small.
const ITEM_FIELDS = `next,items(item(${TRACK_FIELDS}),track(${TRACK_FIELDS}))`;

/** @typedef {'ok'|'restricted'|'failed'} PlaylistStatus */

/** Spotify lists images largest first, but the order isn't guaranteed. */
function pickArtwork(images = []) {
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const thumbnail = sorted.find((image) => (image.width ?? 0) >= SHELF_ART_MIN_WIDTH) ?? sorted.at(-1);
  return { thumbUrl: thumbnail?.url ?? null, fullUrl: sorted.at(-1)?.url ?? null };
}

/** @returns the app's song model, or null for anything that isn't a song (such as an episode) */
export function mapPlaylistEntry(entry) {
  return mapTrack(entry?.item ?? entry?.track);
}

function mapTrack(track) {
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

/** A shelf the app assembles itself. It has no playlist URI, so Spotify can't play it as a playlist. */
const assembledShelf = (id, name, tracks) => ({ id, uri: null, name, tracks, status: 'ok' });

async function fetchLikedSongs(api) {
  const tracks = [];
  let url = `/me/tracks?limit=${SAVED_PAGE_SIZE}`;
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

async function fetchTopSongs(api) {
  const page = await api.get(`/me/top/tracks?limit=${TOP_SONGS_COUNT}&time_range=${TIME_RANGE}`);
  return page.items.map(mapTrack).filter(Boolean);
}

/** The same song often has several URIs, such as on an album and a single, so match on its name. */
const songKey = (track) => `${track.title}|${track.artists[0] ?? ''}`.toLowerCase();

/** A search's songs, most relevant first, keeping only those that `keep` accepts. */
async function searchSongs(api, filter, keep) {
  const query = encodeURIComponent(filter);
  const songs = [];
  for (let pageIndex = 0; pageIndex < SEARCH_PAGES_PER_SOURCE; pageIndex++) {
    const offset = pageIndex * SEARCH_PAGE_SIZE;
    const page = await api.get(`/search?q=${query}&type=track&limit=${SEARCH_PAGE_SIZE}&offset=${offset}`);
    for (const raw of page.tracks?.items ?? []) {
      const track = raw && keep(raw) ? mapTrack(raw) : null;
      if (track) songs.push(track);
    }
    if (!page.tracks?.next) break;
  }
  return songs;
}

/** The genres most common among these artists, most common first. */
function topGenres(artists) {
  const counts = new Map();
  for (const genre of artists.flatMap((artist) => artist.genres ?? [])) {
    counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SUGGESTION_GENRE_COUNT)
    .map(([genre]) => genre);
}

/**
 * Songs for the user to try, leaving out anything they already have. Genre searches come
 * first and skip the user's top artists, which is where artists new to them come from, then
 * come other songs by those top artists. Takes one song from each source in turn, so no
 * single genre or prolific artist can fill the shelf.
 */
async function fetchSuggestions(api, knownTracks) {
  const { items: artists } = await api.get(`/me/top/artists?limit=${TOP_ARTIST_COUNT}&time_range=${TIME_RANGE}`);
  const artistIds = new Set(artists.map((artist) => artist.id));
  const hasArtist = (raw, matches) => (raw.artists ?? []).some(matches);

  const sources = [
    ...topGenres(artists).map((genre) => ({
      filter: `genre:"${genre}"`,
      keep: (raw) => !hasArtist(raw, (candidate) => artistIds.has(candidate.id)),
    })),
    ...artists.map((artist) => ({
      filter: `artist:"${artist.name}"`,
      // Search also returns songs that merely mention the name.
      keep: (raw) => hasArtist(raw, (candidate) => candidate.id === artist.id),
    })),
  ];
  await forEachLimited(sources, SEARCH_CONCURRENCY, async (source) => {
    source.songs = await searchSongs(api, source.filter, source.keep);
  });

  const seen = new Set(knownTracks.map(songKey));
  const suggestions = [];
  const lists = sources.map((source) => source.songs);
  for (let turn = 0; suggestions.length < SUGGESTION_COUNT && lists.some((list) => turn < list.length); turn++) {
    for (const list of lists) {
      const track = list[turn];
      if (!track || seen.has(songKey(track)) || suggestions.length === SUGGESTION_COUNT) continue;
      seen.add(songKey(track));
      suggestions.push(track);
    }
  }
  return suggestions;
}

/**
 * Builds the shelves that don't come from a playlist. One failing doesn't stop the others.
 * A 403 means the session predates these shelves' permissions, so it reports `needsReconnect`.
 * A shelf with no songs is left out, except for Liked Songs: every library has that playlist,
 * so its shelf always appears, and says why if its songs couldn't be loaded.
 *
 * @param {import('./apiClient.js').SpotifyApiClient} api
 * @param {Array<{tracks: object[]}>} playlists already loaded, so suggestions can skip their songs
 * @returns {Promise<{shelves: object[], needsReconnect: boolean, failed: number}>}
 */
export async function fetchAssembledShelves(api, playlists) {
  const result = { shelves: [], needsReconnect: false, failed: 0 };

  const load = async (fetchTracks, id, name, { alwaysShow = false } = {}) => {
    const shelf = assembledShelf(id, name, []);
    try {
      shelf.tracks = await fetchTracks();
    } catch (error) {
      // Not an API response, such as an expired session: let the app handle it.
      if (!(error instanceof SpotifyApiError)) throw error;
      console.warn(`Could not load "${name}":`, error.message);
      if (error.status === 403) {
        result.needsReconnect = true;
        shelf.status = 'reconnect';
      } else {
        result.failed++;
        shelf.status = 'failed';
      }
    }
    if (shelf.tracks.length > 0 || alwaysShow) result.shelves.push(shelf);
    return shelf.tracks;
  };

  // Liked Songs is every song the user has liked, whether or not it's in another playlist.
  const liked = await load(() => fetchLikedSongs(api), 'liked-songs', 'Liked Songs', { alwaysShow: true });
  const top = await load(() => fetchTopSongs(api), TOP_SONGS_ID, 'Your Top Songs');
  const known = [...playlists.flatMap((playlist) => playlist.tracks), ...liked, ...top];
  await load(() => fetchSuggestions(api, known), 'suggested', 'Suggested For You');
  return result;
}
