/**
 * Decides which bookshelves exist: one per playlist, plus overflow shelves when
 * a playlist has more songs than a single shelf holds.
 */

import { MAX_RECORDS_PER_SHELF } from './shelfGeometry.js';

/**
 * @param {Array<{name: string, tracks: object[]}>} playlists
 * @returns {Array<{playlist: object, part: number, partCount: number, label: string, tracks: object[]}>}
 */
export function planBookshelves(playlists, maxRecords = MAX_RECORDS_PER_SHELF) {
  const shelves = [];
  for (const playlist of playlists) {
    // An empty playlist still gets a shelf, so every playlist is visible in the room.
    const partCount = Math.max(1, Math.ceil(playlist.tracks.length / maxRecords));
    for (let part = 0; part < partCount; part++) {
      shelves.push({
        playlist,
        part: part + 1,
        partCount,
        label: partCount > 1 ? `${playlist.name} (${part + 1}/${partCount})` : playlist.name,
        tracks: playlist.tracks.slice(part * maxRecords, (part + 1) * maxRecords),
      });
    }
  }
  return shelves;
}
