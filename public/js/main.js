/**
 * Composition root: decides how the session starts, then wires authentication,
 * Spotify services, the 3D scene and the UI together. Modules don't know about each
 * other beyond the interfaces passed in here.
 */

import { AuthClient, AuthExpiredError } from './auth/authClient.js';
import { buildBookshelves, shelfFocusView } from './bookshelves/bookshelfGenerator.js';
import { ROOM_SIZE } from './bookshelves/shelfLayout.js';
import { planBookshelves } from './bookshelves/shelfPlanner.js';
import { SongInteractions } from './interactions/songInteractions.js';
import { buildRoom } from './scene/room.js';
import { SceneManager } from './scene/sceneManager.js';
import { SpotifyApiClient } from './spotify/apiClient.js';
import { createDemoLibrary, DemoPlayback } from './spotify/demoLibrary.js';
import { fetchLibrary } from './spotify/libraryService.js';
import { SpotifyPlayback } from './spotify/playbackService.js';
import { NowPlayingBar } from './ui/nowPlayingBar.js';
import { ShelfDrawer } from './ui/shelfDrawer.js';
import { SongPanel } from './ui/songPanel.js';
import { showToast } from './ui/toast.js';
import { WelcomeOverlay } from './ui/welcomeOverlay.js';
import { PlayingGlow } from './vinyl/playingGlow.js';
import { VinylRecords } from './vinyl/vinylRecords.js';

const AUTH_ERROR_MESSAGES = {
  access_denied: 'Spotify access was declined. Connect again whenever you\'re ready.',
  not_configured: 'Spotify credentials aren\'t set up on the server yet.',
  state_mismatch: 'That sign-in attempt could not be verified. Please try again.',
};

const auth = new AuthClient();
const welcome = new WelcomeOverlay({
  onConnect: () => auth.login(),
  onDemo: () => window.location.assign('/?demo=1'),
});

/** Builds the room's contents for a library and connects them to playback and the UI. */
function openRoom(sceneManager, playlists, playback, { demoMode, onSignOut }) {
  const shelves = buildBookshelves(sceneManager.scene, sceneManager.renderer, planBookshelves(playlists));
  sceneManager.refreshShadows();

  // The default viewpoint sits where freestanding rows stand, so start in the open centre.
  const isFreestanding = (shelf) => Math.max(Math.abs(shelf.x), Math.abs(shelf.z)) < ROOM_SIZE / 2 - 1;
  if (shelves.some(isFreestanding)) sceneManager.camera.position.set(1.8, 2.3, 2.3);

  const vinyl = new VinylRecords(sceneManager.scene, sceneManager.renderer, shelves);
  const glow = new PlayingGlow(sceneManager.scene, vinyl);
  sceneManager.onFrame((delta) => {
    const changed = vinyl.update(delta);
    glow.update();
    return changed;
  });

  let playbackState = null;
  /** The record the user just asked to play, so the right copy of a duplicated song lights up. */
  let requestedRecord = null;

  const isOpenRecordCurrent = () => songPanel.record !== null && vinyl.playingRecord === songPanel.record;
  const refreshPanelState = () =>
    songPanel.setPlayState({
      isCurrent: isOpenRecordCurrent(),
      paused: playbackState?.paused ?? true,
    });
  const reportFailure = (error) => showToast(error.message);

  const songPanel = new SongPanel({
    onPlay: (record) => {
      if (isOpenRecordCurrent()) {
        playback.toggle().catch(reportFailure);
      } else {
        requestedRecord = record;
        playback.playTrack(record.track, record.shelf.playlist).catch(reportFailure);
      }
    },
    onClose: () => {
      vinyl.setSelected();
      sceneManager.invalidate();
    },
  });

  const nowPlaying = new NowPlayingBar({
    onToggle: () => playback.toggle().catch(reportFailure),
    onNext: () => playback.next()?.catch(reportFailure),
    onPrevious: () => playback.previous()?.catch(reportFailure),
    onVolume: (volume) => playback.setVolume(volume),
  });

  const resolvePlayingInstance = (state) => {
    if (requestedRecord && state.uris.includes(requestedRecord.track.uri)) {
      return requestedRecord.instanceId;
    }
    const current = vinyl.playingRecord;
    if (current && state.uris.includes(current.track.uri)) return current.instanceId;
    return vinyl.findInstance(state.uris, state.contextUri);
  };

  playback.onState((state) => {
    playbackState = state;
    nowPlaying.update(state);
    if (state) vinyl.setPlaying(resolvePlayingInstance(state), state.paused);
    else vinyl.setPlaying();
    refreshPanelState();
    sceneManager.invalidate();
  });

  playback.onError((message, { fatal }) => {
    showToast(message, 9000);
    if (fatal) songPanel.disablePlayback(message);
  });

  const focusShelf = (shelf) => sceneManager.focusOn(shelfFocusView(shelf));

  new SongInteractions({
    sceneManager,
    shelves,
    vinyl,
    onRecordClick: (record) => {
      songPanel.open(record);
      vinyl.setSelected(record.instanceId);
      refreshPanelState();
      sceneManager.invalidate();
    },
    onShelfClick: focusShelf,
  });

  const drawer = new ShelfDrawer({
    demoMode,
    onSignOut,
    signOutLabel: demoMode ? 'Exit demo' : 'Sign out',
  });
  drawer.render(shelves, focusShelf);

  playback.start();
  welcome.hide();
}

function reportUnreadablePlaylists(playlists) {
  const restricted = playlists.filter((playlist) => playlist.status === 'restricted').length;
  const failed = playlists.filter((playlist) => playlist.status === 'failed').length;
  const notes = [];
  if (restricted > 0) {
    notes.push(
      `Spotify only shares songs from playlists you own or collaborate on, so ${restricted} followed ${restricted === 1 ? 'playlist is an empty shelf' : 'playlists are empty shelves'}.`,
    );
  }
  if (failed > 0) {
    notes.push(`${failed} ${failed === 1 ? 'playlist' : 'playlists'} could not be loaded. Reload to retry.`);
  }
  if (notes.length > 0) showToast(notes.join(' '), 12000);
}

async function startSpotifySession(sceneManager) {
  const getToken = (options) => auth.getAccessToken(options);
  const api = new SpotifyApiClient(getToken);

  welcome.showProgress('Finding your playlists…');
  const playlists = await fetchLibrary(api, (loaded, total) => {
    welcome.showProgress(`Pulling records from ${loaded} of ${total} playlists…`, total ? loaded / total : 0);
  });

  openRoom(sceneManager, playlists, new SpotifyPlayback(api, getToken), {
    demoMode: false,
    onSignOut: async () => {
      await auth.logout();
      window.location.assign('/');
    },
  });
  reportUnreadablePlaylists(playlists);
}

function startDemoSession(sceneManager) {
  openRoom(sceneManager, createDemoLibrary(), new DemoPlayback(), {
    demoMode: true,
    onSignOut: () => window.location.assign('/'),
  });
}

/** Removes the one-shot auth result from the URL, so a reload doesn't show it again. */
function takeAuthError(params) {
  const code = params.get('auth_error');
  if (code) window.history.replaceState(null, '', window.location.pathname);
  return code;
}

async function main() {
  const params = new URLSearchParams(window.location.search);
  const authError = takeAuthError(params);

  let sceneManager;
  try {
    sceneManager = new SceneManager(document.getElementById('scene-root'));
    buildRoom(sceneManager.scene, sceneManager.renderer);
  } catch (error) {
    console.error(error);
    welcome.showChoices({ canConnect: false });
    welcome.showMessage('This browser or device can\'t display the 3D room because WebGL 2 is unavailable.');
    return;
  }

  if (params.has('demo')) {
    startDemoSession(sceneManager);
    return;
  }

  let status;
  try {
    status = await auth.getStatus();
  } catch (error) {
    welcome.showChoices({ canConnect: false });
    welcome.showMessage(error.message);
    return;
  }

  if (!status.authenticated) {
    welcome.showChoices({ canConnect: status.configured });
    if (authError) {
      welcome.showMessage(AUTH_ERROR_MESSAGES[authError] ?? `Spotify sign-in failed (${authError}).`);
    } else if (!status.configured) {
      welcome.showMessage(`To connect Spotify, add ${status.missing.join(' and ')} to .env and restart the server.`);
    }
    return;
  }

  try {
    await startSpotifySession(sceneManager);
  } catch (error) {
    console.error(error);
    welcome.showChoices({ canConnect: status.configured });
    welcome.showMessage(
      error instanceof AuthExpiredError ? error.message : `Could not load your library: ${error.message}`,
    );
  }
}

main();
