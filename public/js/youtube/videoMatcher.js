/**
 * Asks our server which YouTube videos to try for a song. The server holds the API key
 * and remembers past answers. This also remembers them for the page's lifetime, so
 * playing a song again doesn't even ask the server.
 */

const matches = new Map();

/** The query string for a song, as /youtube/match expects it. */
export function matchQuery(track) {
  const params = new URLSearchParams({ title: track.title, artist: track.artists.join(', ') });
  if (track.durationMs > 0) params.set('durationMs', String(Math.round(track.durationMs)));
  return params;
}

async function requestVideos(track, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`/youtube/match?${matchQuery(track)}`);
  } catch {
    throw new Error('Could not reach the app server to find this song on YouTube.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Could not find this song on YouTube.');
  return body.videos ?? [];
}

/**
 * @param {{uri: string, title: string, artists: string[], durationMs: number}} track
 * @returns {Promise<Array<{id: string, title: string, channel: string}>>} best first
 */
export function findVideos(track, fetchImpl = fetch) {
  if (!matches.has(track.uri)) {
    const lookup = requestVideos(track, fetchImpl).catch((error) => {
      matches.delete(track.uri); // failures aren't remembered, so a retry can succeed
      throw error;
    });
    matches.set(track.uri, lookup);
  }
  return matches.get(track.uri);
}
