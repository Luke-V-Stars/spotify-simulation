# spotify-simulation

**Vinyl Listening Room**: a 3D space where your Spotify library is viewable and can play music.

Every playlist becomes a walnut bookshelf in a wood-panelled listening room sized to your library, and every song a vinyl record in a sleeve showing its album cover. Walk around the room, click a record to see the song's details, and play it right there from a full player bar with seeking and volume: through Spotify with Premium, or from YouTube on a TV for anyone else. Your top 5 songs hang on the wall as gold record awards.

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
- **The app owner needs Premium**, and a new app is limited to 5 users, who must be added in the dashboard. Anyone else can log in, but the app then shows an error asking them to get added.
- **Playback requires Premium for each listener**, plus a browser that supports EME (desktop Chrome, Edge or Firefox). Anyone else can still browse the shelves and song details.

Choosing **Connect Spotify** always asks for a Spotify login. To do that it first ends the browser's Spotify session, which also signs that browser out of other Spotify sites such as the web player.

## Playing from YouTube (optional)

Songs can also play from YouTube on a TV in the corner of the screen. This is for listeners Spotify can't play for, such as without Premium or on a phone, and for anyone who chooses it with the **Play from** button in the top bar.

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create an API key, and enable **YouTube Data API v3** for its project. Restricting the key to that API is a good idea.
2. Add it to `.env` as `YOUTUBE_API_KEY`, and restart the server.

The key stays on the server, which searches YouTube for each song. Only the video IDs reach the browser.

- **Which video plays:** the server searches for the artist and title, then puts the videos whose length is closest to the Spotify song's first, which favours the studio recording over live versions and long music videos. If a video's owner doesn't allow it to play on other sites, the next match plays instead.
- **Automatic switch:** when Spotify can't play in this session, songs switch to YouTube by themselves and the **Play from** button goes away.
- **The daily limit:** Google's default quota allows about 100 searches a day, and it resets at midnight Pacific time. Each song is searched for only the first time it's played. Matches are saved in `data/youtube-matches.json`, which is ignored by git, and kept for 30 days, so replaying songs or restarting the server costs nothing.
- **Ads** play as they would on YouTube.
- **The on-screen TV** stays visible, at least 200 × 200 pixels and uncovered, while a song is loaded, as YouTube's rules for embedded players require. The song panel moves below it. Its line underneath shows which video is playing, so a wrong match is easy to spot.
- **The TV in the room** hangs on the far wall above the plaques. It shows the cover, title and artist of whatever is playing, from either service. It can't show the video itself, because browsers don't let a page read the picture from another site's player.
- **Next and previous** move through the whole playlist, or through the shelf for Liked Songs, Your Top Songs and Suggested For You. At the end of the list, playback stops. A song with no playable video is skipped when the list reaches it, but not when you chose it yourself.
- **The demo room stays silent:** its songs are invented, so there's nothing to find on YouTube.

## Controls

| Action | Mouse | Touch |
| --- | --- | --- |
| Walk, by pulling the floor as when dragging a map | Left-drag, starting below eye level | One-finger drag, starting below eye level |
| Look around | Right-drag | Two-finger drag |
| Walk forward or back | Scroll | Pinch |
| Open a song's details | Click a record | Tap a record |
| Fly to a shelf | Click the shelf, or choose it under **Shelves** | Tap the shelf, or choose it under **Shelves** |

### Player bar

Once a song is playing, a bar along the bottom of the screen shows its cover, title and artist, with:

- **Previous / next** song, and **play / pause**.
- **−10 / +10** buttons to skip back or forward 10 seconds.
- A **timeline** showing elapsed and total time. Drag it to seek: the song only jumps when you let go, and the slider isn't pulled from under you while you hold it.
- A **volume** slider.

The demo room's player simulates the same position, seeking and track changes without any audio.

## How it behaves

- **Shelves:** each holds up to 50 records, with overflow shelves added beside it and labelled by part, such as `Road Trip (2/3)`. Empty playlists still get a shelf.
- **Extra shelves:** Liked Songs comes first and holds every song you've liked, followed by Your Top Songs (your top 50 from about the last 6 months) and Suggested For You. Suggestions are up to 50 songs you don't already have: songs in your top artists' most common genres, then other songs by those artists. They're built from search results because Spotify has deprecated its recommendations endpoint, and the genre part depends on a field Spotify has also marked deprecated, so they aren't Spotify's own personalised picks. Next and previous stay within the shelf on these, as they're played by song rather than as a playlist. If you connected before these shelves were added, restart the server, then sign out and connect again to grant the new permissions.
- **Wall plaques:** your top 5 songs hang on the far wall like gold record awards, with number one at the centre. Clicking one opens that song, as with any record.
- **The room:** a polished oak plank floor, walnut panelling below fabric-covered walls, crown moulding, a beamed ceiling and recessed warm downlights that throw scallops of light on the walls. Every texture is painted on a canvas when the page loads, so the project ships no image files.
- **The shelves:** walnut, with softened edges, a stepped top, raised strips up each side and a lip along each board to keep records in. Each shelf is a slightly different tone, as if cut from a different board, and a hidden warm light strip under each board glows down the back between the records.
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
  youtubeMatches.js      Finds each song's YouTube video, and remembers matches; the only code that uses the YouTube key
  app.js                 Routes and static files
public/js/
  main.js                Connects all the modules below
  auth/                  Browser side of authentication
  spotify/               Web API client, library loading, Playback SDK, demo mode
  youtube/               YouTube's player, asking the server for matches, playing through a list
  playback/              Switching between Spotify and YouTube
  scene/                 Renderer, camera, walking controls, the room, the wall TV, painted textures, softened-box woodwork, texture arrays
  bookshelves/           Which shelves exist, the room's size, where they stand, their meshes
  vinyl/                 Instanced sleeves and discs, shader, album art streaming, glow, wall plaques
  interactions/          Hover and click handling, and picking
  ui/                    Panels, drawer, now-playing bar, TV panel, source button, overlay, formatting
tests/                   Unit and server tests (npm test)
```

There's no build step: the browser loads ES modules directly, and the server exposes Three.js from `node_modules`.

### Authentication

The browser never sees the client secret or the refresh token. The server runs the Authorization Code flow, keeps the refresh token in an `HttpOnly` cookie, and hands the browser short-lived access tokens from `/auth/token`, held in memory only. The Web Playback SDK requires those tokens client-side. For a public deployment, use an HTTPS redirect URI, which also turns on `Secure` cookies.

Pages are served with `Referrer-Policy: strict-origin-when-cross-origin`, because YouTube's embedded player refuses to play without a Referer naming the site. Other sites receive only the origin, never a full URL. For a public deployment, note that anyone who can reach the server can use `/youtube/match`, and so spend the day's search quota.

### Performance

The room is designed so that cost grows slowly with library size:

- **One draw call for all records.** Sleeves and their discs are a single `InstancedMesh`, and covers come from a texture array selected per instance. A disc inside its sleeve isn't drawn.
- **No per-frame data uploads.** Hover, selection, spin and glow are uniforms compared against `gl_InstanceID` in the shader.
- **Picking does no raycasting against triangles.** `recordPicker.js` intersects the ray with each shelf's box and computes the grid cell, so its cost depends on shelf count rather than song count.
- **Rendering on demand.** A still room issues no draw calls at all.
- **All shelves in one mesh.** Every shelf's woodwork, light strip and engraved name is an instance of a shared mesh, so adding shelves barely adds draw calls. `boxBatch.js` builds the woodwork from real-sized boxes whose shared-vertex chamfers read as rounded edges at 44 triangles a box.
- **Few real lights.** Every ceiling fixture glows, but only five are real lights, since each one costs every pixel. A painted environment map supplies the sheen on polished wood and keeps faces turned away from the lamps from going black.
- **Static shadows.** The shadow map is drawn once, since shelves don't move.
- **Simpler shelves when there are many.** Past 200 shelves, each drops its softened edges and small decorative parts, going from about 900 triangles to about 150.
- **Streamed artwork.** Covers load in the background using Spotify's 300px images, scaled down, and upload in batches. The song panel uses the full-size image.

## Tests

```sh
npm test
```

These cover shelf planning and layout, shelf geometry and softened boxes, walking and collisions, picking, Spotify response handling and retries, library error messages, player position and seeking, YouTube matching, quota errors and the match cache with YouTube mocked, the YouTube player and switching between services, the OAuth routes with Spotify mocked, and static file safety. No credentials or network access are needed.
