/**
 * Demo mode: an invented library and simulated (silent) playback, so the room can
 * be explored and developed before Spotify credentials are added.
 * All names and artwork here are generated, none refer to real releases.
 */

import { TOP_SONGS_ID } from './libraryService.js';

const WORDS_A = ['Amber', 'Velvet', 'Slow', 'Midnight', 'Paper', 'Hollow', 'Golden', 'Quiet', 'Copper', 'Salt', 'Distant', 'Ember'];
const WORDS_B = ['Rooms', 'Harbor', 'Static', 'Orchard', 'Signal', 'Tides', 'Letters', 'Lanterns', 'Motel', 'Satellites', 'Dust', 'Rivers'];
const ARTISTS = ['The Night Clerks', 'Ana Morrow', 'Low Atlas', 'Fennel & Finch', 'Kaito Rivers', 'Ember Parade', 'Juno Vale', 'Soft Machinery'];

/** Includes the cases worth exercising: exact and over-capacity shelves, and an empty playlist. */
const DEMO_PLAYLISTS = [
  ['Liked Songs', 136],
  ['Your Top Songs', 50, TOP_SONGS_ID],
  ['Suggested For You', 50],
  ['The Whole Collection', 500],
  ['Late Night Jazz', 50],
  ['Road Trip', 137],
  ['Sunday Morning', 24],
  ['Just Over One Shelf', 51],
  ['Rainy Day Instrumentals', 72],
  ['Workout', 41],
  ['New Playlist (empty)', 0],
];

const TRACKS_PER_ALBUM = 9;

/** Same input, same output, so the demo room looks identical on every visit. */
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length)];

/**
 * Browsers decode SVGs far more slowly than the JPEGs Spotify serves, and thousands of
 * them stall the page for over a minute. Test scale with JPEGs, not by growing this demo.
 */
function artworkDataUrl(random, initials) {
  const hue = Math.floor(random() * 360);
  const size = 40 + Math.floor(random() * 90);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 70% 55%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 60) % 360} 75% 22%)"/>
    </linearGradient></defs>
    <rect width="300" height="300" fill="url(#g)"/>
    <circle cx="${90 + size}" cy="${100 + size / 2}" r="${size}" fill="hsl(${(hue + 180) % 360} 80% 70%)" opacity=".75"/>
    <text x="150" y="240" font-family="Georgia, serif" font-size="64" text-anchor="middle" fill="#fff">${initials}</text>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function buildAlbum(random) {
  const first = pick(random, WORDS_A);
  const second = pick(random, WORDS_B);
  const artUrl = artworkDataUrl(random, first[0] + second[0]);
  return {
    name: `${first} ${second}`,
    artist: pick(random, ARTISTS),
    artUrl,
    releaseDate: `${1968 + Math.floor(random() * 57)}-${String(1 + Math.floor(random() * 12)).padStart(2, '0')}-15`,
  };
}

/** @returns playlists in the same shape libraryService.js produces */
export function createDemoLibrary() {
  const random = seededRandom(20261105);

  return DEMO_PLAYLISTS.map(([name, count, id], playlistIndex) => {
    const tracks = [];
    let album = buildAlbum(random);
    for (let i = 0; i < count; i++) {
      if (i % TRACKS_PER_ALBUM === 0) album = buildAlbum(random);
      tracks.push({
        uri: `demo:track:${playlistIndex}:${i}`,
        title: `${pick(random, WORDS_A)} ${pick(random, WORDS_B)}`,
        artists: [album.artist],
        album: album.name,
        durationMs: 120_000 + Math.floor(random() * 240_000),
        releaseDate: album.releaseDate,
        releaseDatePrecision: 'day',
        artThumbUrl: album.artUrl,
        artFullUrl: album.artUrl,
        isLocal: false,
      });
    }
    return { id: id ?? `demo-${playlistIndex}`, uri: `demo:playlist:${playlistIndex}`, name, tracks, status: 'ok' };
  });
}

/** Stands in for SpotifyPlayback in demo mode: same interface, no audio. */
export class DemoPlayback {
  #stateListeners = [];
  #playlist = null;
  #index = -1;
  #paused = true;

  onState(callback) {
    this.#stateListeners.push(callback);
  }

  onError() {}

  async start() {}

  async playTrack(track, playlist) {
    this.#playlist = playlist;
    this.#index = playlist.tracks.indexOf(track);
    this.#paused = false;
    this.#emit();
  }

  async toggle() {
    this.#paused = !this.#paused;
    this.#emit();
  }

  async next() {
    this.#step(1);
  }

  async previous() {
    this.#step(-1);
  }

  setVolume() {}

  #step(direction) {
    if (!this.#playlist) return;
    const count = this.#playlist.tracks.length;
    this.#index = (this.#index + direction + count) % count;
    this.#paused = false;
    this.#emit();
  }

  #emit() {
    const track = this.#playlist.tracks[this.#index];
    const state = {
      uris: [track.uri],
      title: track.title,
      artist: track.artists.join(', '),
      artUrl: track.artThumbUrl,
      paused: this.#paused,
      contextUri: this.#playlist.uri,
    };
    this.#stateListeners.forEach((listener) => listener(state));
  }
}
