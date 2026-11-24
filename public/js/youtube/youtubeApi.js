/**
 * Loads YouTube's IFrame Player API and creates the player in the on-screen TV.
 * Nothing here runs until a song is first played from YouTube, so Spotify listeners
 * never load YouTube's scripts.
 */

const API_URL = 'https://www.youtube.com/iframe_api';
const READY_TIMEOUT_MS = 15_000;

let apiPromise = null;

/** Loads the API script once, resolving with the global `YT` namespace. */
function loadApi() {
  apiPromise ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = API_URL;
    script.async = true;
    script.onerror = () => {
      apiPromise = null; // allow a retry, for example after a network blip
      reject(new Error('Could not load the YouTube player.'));
    };
    document.head.append(script);
  });
  return apiPromise;
}

/**
 * Replaces `element` with a YouTube player and resolves once it's ready for videos.
 * @param {HTMLElement} element
 * @param {{onStateChange: (state: number) => void, onError: (code: number) => void, onAutoplayBlocked: () => void}} handlers
 */
export async function createYouTubePlayer(element, handlers) {
  const YT = await loadApi();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The YouTube player is taking too long to load.')),
      READY_TIMEOUT_MS,
    );
    const player = new YT.Player(element, {
      width: '100%',
      height: '100%',
      playerVars: {
        playsinline: 1, // play inside the TV on phones, not full screen
        rel: 0, // related videos at the end come from the same channel
        iv_load_policy: 3, // no video annotations
        origin: window.location.origin, // the player only talks to this page
      },
      events: {
        onReady: () => {
          clearTimeout(timer);
          resolve(player);
        },
        onStateChange: (event) => handlers.onStateChange(event.data),
        onError: (event) => handlers.onError(event.data),
        onAutoplayBlocked: () => handlers.onAutoplayBlocked(),
      },
    });
  });
}
