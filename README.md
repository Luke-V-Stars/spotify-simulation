# spotify-simulation

A 3D space where your Spotify library is viewable and can play music.

Every playlist becomes a bookshelf in a listening room sized to your library, and every song a vinyl record in a sleeve showing its album cover. Walk around the room, click a record to see the song's details, and, with Spotify Premium, play it right there.

## Quick start

Requires Node 20.12 or newer.

```sh
npm install
npm start
```

Open <http://127.0.0.1:8888> and choose **Explore the demo room**. The demo needs no Spotify account: it uses an invented library and silently simulates playback, so everything except the audio can be tried straight away.

## Connecting Spotify

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Add this Redirect URI to the app: `http://127.0.0.1:8888/auth/callback`
3. Under APIs, enable **Web API** and **Web Playback SDK**.
4. Copy `.env.example` to `.env` and fill in the values:

   | Variable | Value |
   | --- | --- |
   | `SPOTIFY_CLIENT_ID` | From the dashboard |
   | `SPOTIFY_CLIENT_SECRET` | From the dashboard. Stays on the server |
   | `SPOTIFY_REDIRECT_URI` | Must exactly match the dashboard |

5. Restart the server and click **Connect Spotify**.

Open the app at `127.0.0.1`, not `localhost`: Spotify no longer accepts `localhost` redirect URIs. `.env` is ignored by git, so credentials stay out of the repository.

### Spotify's limits

These come from Spotify's [February 2026 changes](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) and apply to apps in Development Mode:

- **Followed playlists appear as empty shelves.** Spotify only returns songs for playlists the user owns or collaborates on. The shelf and name still appear, and the app explains why they're empty. Apps with Extended Quota aren't affected.
- **The app owner needs Premium**, and a new app is limited to 5 users, who must be added in the dashboard.
- **Playback requires Premium for each listener**, plus a browser that supports EME (desktop Chrome, Edge or Firefox). Anyone else can still browse the shelves and song details.

## Controls

| Action | Mouse | Touch |
| --- | --- | --- |
| Walk, by pulling the floor as when dragging a map | Left-drag, starting below eye level | One-finger drag, starting below eye level |
| Look around | Right-drag | Two-finger drag |
| Walk forward or back | Scroll | Pinch |
| Open a song's details | Click a record | Tap a record |
| Fly to a shelf | Click the shelf, or choose it under **Shelves** | Tap the shelf, or choose it under **Shelves** |

## How it behaves

- **Shelves:** each holds up to 50 records, with overflow shelves added beside it and labelled by part, such as `Road Trip (2/3)`. Empty playlists still get a shelf.
- **Extra shelves:** Liked Songs comes first and holds every song you've liked, followed by Your Top Songs (your top 50 from about the last 6 months) and Suggested For You. Suggestions are up to 50 songs you don't already have: songs in your top artists' most common genres, then other songs by those artists. They're built from search results because Spotify has deprecated its recommendations endpoint, and the genre part depends on a field Spotify has also marked deprecated, so they aren't Spotify's own personalised picks. Next and previous stay within the shelf on these, as they're played by song rather than as a playlist. If you connected before these shelves were added, restart the server, then sign out and connect again to grant the new permissions.
- **Wall plaques:** your top 5 songs hang on the far wall like gold record awards, with number one at the centre. Clicking one opens that song, as with any record.
- **Room size:** the room is the smallest square that fits every shelf, from 7.5m to 25m across.
- **Placement:** every shelf stands in a freestanding row, like the stacks in a library, either side of a central aisle and clear of the walls (96 in all). Beyond that, all shelves shrink evenly so that nothing is left out.
- **Starting point:** you start against one wall, looking down the central aisle toward your first playlists, which begin at the far end of the rows. Shelves and walls stop you walking through them.
- **Moving and looking up:** facing too far up to see anything below eye level, you can't walk at all until you look back down.
- **Shelf names:** each name is engraved in gold into a wooden header board along the top of its shelf.
- **Records:** a hovered record's vinyl peeks out of its sleeve. A selected or playing record's vinyl slides further out, and spins while playing.
- **Skipped items:** podcast episodes in a playlist aren't shown. Local files appear as records but can't be played.
- **Artwork:** up to 2,047 different covers are shown (fewer on GPUs with lower limits). Records beyond that keep a plain sleeve. Covers are stored at 128px, or 64px for libraries with over 512 of them.

## Project structure

```
server/                  Node server with no framework
  config.js              Reads and validates environment variables
  authRoutes.js          OAuth 2.0 flow; the only code that uses the client secret
  app.js                 Routes and static files
public/js/
  main.js                Connects all the modules below
  auth/                  Browser side of authentication
  spotify/               Web API client, library loading, Playback SDK, demo mode
  scene/                 Renderer, camera, walking controls, the room, texture arrays
  bookshelves/           Which shelves exist, the room's size, where they stand, their meshes
  vinyl/                 Instanced sleeves and discs, shader, album art streaming, glow, wall plaques
  interactions/          Hover and click handling, and picking
  ui/                    Panels, drawer, now-playing bar, overlay, formatting
tests/                   Unit and server tests (npm test)
```

There's no build step: the browser loads ES modules directly, and the server exposes Three.js from `node_modules`.

### Authentication

The browser never sees the client secret or the refresh token. The server runs the Authorization Code flow, keeps the refresh token in an `HttpOnly` cookie, and hands the browser short-lived access tokens from `/auth/token`, held in memory only. The Web Playback SDK requires those tokens client-side. For a public deployment, use an HTTPS redirect URI, which also turns on `Secure` cookies.

### Performance

The room is designed so that cost grows slowly with library size:

- **One draw call for all records.** Sleeves and their discs are a single `InstancedMesh`, and covers come from a texture array selected per instance. A disc inside its sleeve isn't drawn.
- **No per-frame data uploads.** Hover, selection, spin and glow are uniforms compared against `gl_InstanceID` in the shader.
- **Picking does no raycasting against triangles.** `recordPicker.js` intersects the ray with each shelf's box and computes the grid cell, so its cost depends on shelf count rather than song count.
- **Rendering on demand.** A still room issues no draw calls at all.
- **Static shadows.** The shadow map is drawn once, since shelves don't move.
- **Streamed artwork.** Covers load in the background using Spotify's 300px images, scaled down, and upload in batches. The song panel uses the full-size image.

## Tests

```sh
npm test
```

These cover shelf planning and layout, walking and collisions, picking, Spotify response handling and retries, the OAuth routes with Spotify mocked, and static file safety. No credentials or network access are needed.
