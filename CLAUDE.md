# CLAUDE.md

Context for Claude Code sessions in this repository. It's read automatically at the start of every new chat. Keep it up to date: when a session makes a decision or learns something non-obvious, add it under **Decisions and lessons** or **Session log**.

## The project

**Vinyl Listening Room**: a 3D room (Three.js) where each Spotify playlist is a walnut bookshelf and each song a vinyl record. Songs play through the Spotify Web Playback SDK (Premium only) or from YouTube on an on-screen TV. The README describes behaviour in detail. Read it before changing features, and update it when they change.

## Commands

```sh
npm start   # server at http://localhost:8888 (sign-in goes through 127.0.0.1:8888)
npm test    # node --test "tests/*.test.js"; needs no credentials or network
```

Requires Node 20.12 or newer. There's no build step: the browser loads ES modules directly, and the server serves Three.js from `node_modules`.

## Layout

- `server/`: plain `node:http`, no framework.
  - `config.js` reads `.env`.
  - `authRoutes.js` runs Spotify OAuth and is the only code that uses the client secret.
  - `youtubeMatches.js` runs YouTube search and the match cache, and is the only code that uses the YouTube key.
  - `app.js` holds the routes and static files.
- `public/js/main.js` is the composition root. Modules only know each other through the interfaces passed in there.
- `public/js/{auth,spotify,youtube,playback,scene,bookshelves,vinyl,interactions,ui}/` contain the feature modules.
- `tests/`: `server.test.js`, `shelves.test.js`, `spotify.test.js`, `youtube.test.js`.

## Conventions

- **Playback interface:** every source (SpotifyPlayback, YouTubePlayback, DemoPlayback and PlaybackSwitch) has `start`, `playTrack(track, playlist, shelfTracks)`, `toggle`, `next`, `previous`, `seek(ms)`, `setVolume(v)`, `onState(cb)` and `onError(cb(message, {fatal}))`.
- **Rendering on demand:** call `sceneManager.invalidate()` after anything visible changes.
- **Dependency injection:** servers and players take injectable `fetchImpl`, `createPlayer` and similar, so tests never reach Spotify or YouTube.
- **Error messages** are written for the user, plainly, and never include secrets.
- **Line endings are mixed.** `README.md`, `server/authRoutes.js` and `public/js/main.js` use CRLF. Scripted find-and-replace must handle `\r\n`.

## Secrets and safety

- `.env` holds `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI` and `YOUTUBE_API_KEY`. Never print, read out or commit its values. To check a key loaded, report only whether it's set and its length.
- `data/` (the YouTube match cache) is gitignored.
- Never kill every Node process (`taskkill /IM node.exe`, `pkill node`). Stop only the specific PID, for example the one listening on a port.
- The user often has their own `npm start` running on port 8888. Don't stop it. For checks, run a second copy on another port, for example `SPOTIFY_REDIRECT_URI=http://127.0.0.1:8899/auth/callback node server/index.js`.

## Decisions and lessons

- **localhost vs 127.0.0.1:** Spotify rejects `localhost` redirect URIs, so sign-in uses `127.0.0.1`. YouTube refuses to play music videos (error 150) on a page addressed by an IP number, which was confirmed in headless Chrome: the same videos play at `localhost`. So the room is served at `localhost` (`config.appOrigin`), and `127.0.0.1` pages redirect there. After the OAuth callback, the session is handed over through `/auth/handoff` with a one-time, 60-second code bound to a `sp_handoff` nonce cookie. Hosted deployments with a real domain don't hand over.
- **Referrer-Policy is `strict-origin-when-cross-origin`**, because YouTube's embed requires a Referer.
- **YouTube's on-screen TV** must stay visible, at least 200×200 and uncovered, under YouTube's policy. The 3D wall TV shows cover art, because cross-origin iframes can't be drawn into WebGL.
- **YouTube quota:** search costs 100 units against a default of 10,000 a day, so about 100 new songs a day. Matches are cached for 30 days in `data/youtube-matches.json`. Anyone who can reach `/youtube/match` can spend the quota, which matters for a public deployment.
- **YouTube Premium can't remove ads** in embedded players for guests. The user dropped that idea.
- **Spotify Development Mode limits (February 2026):** followed playlists come back without songs, there are 5 allowlisted users, and playback needs Premium for every listener.
- **Demo mode** (`/?demo=1`) uses an invented library and stays silent, even on YouTube.
- **Debugging YouTube playback:** a headless Chrome driven over the DevTools protocol (Node's built-in `WebSocket`) can embed the IFrame API on the app's page and log state and error codes for given video IDs. This is how the error-150 cause was found.

## Ideas discussed, not built

- **Multiplayer** (several people in one room, hearing the same song): talked through, but no code exists yet. Shared listening needs a source every guest can play, which is why YouTube was added.
- **Other music sources:** Audius and Jamendo were considered, but their catalogues don't match Spotify's.

## Working with this user

- They want clear, numbered steps when setting things up outside the code, such as the Google Cloud console or the Spotify dashboard.
- Commit and push only when asked. Keep the README current with what's been built.

## Session log

Newest first. Add a line or two for each session that changes something.

- **2026-11-24:**
  - Added the YouTube TV playback source, the Play-from toggle, the wall TV and the server-side match cache, committed by the user as d4540fc.
  - Helped create the YouTube Data API v3 key, restricted to that API.
  - Fixed videos cycling through matches (error 150 at `127.0.0.1`) by serving the room at `localhost` with a sign-in handover (c371bc0). Tests: 192 passing.
- **Earlier:** built the room, shelves, records, player bar, wall plaques and graphics, and updated the README (e09abed).
