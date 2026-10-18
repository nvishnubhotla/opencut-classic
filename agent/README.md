# OpenCut agent tools

Lets Claude (or any MCP client) edit videos in OpenCut. The editor runs in a
browser tab (headless by default) driven over Playwright; a dev-only bridge in
`apps/web/src/agent-bridge` exposes the editor's commands.

## Requirements

- Node 22+, Chrome or Edge (set `OPENCUT_BROWSER` to use another Chromium)
- `ffmpeg`/`ffprobe` on PATH (silence cutting, GIF conversion, contact sheets)
- Dependencies: `npm install` at the repo root and in `agent/`

## Add to Claude Code

```sh
claude mcp add opencut -- node D:/Workspace/opencut-classic/agent/mcp-server.mjs
```

The server starts the web dev server (`apps/web`, port 3000) if it isn't
running, and opens the editor on the first tool call. Set `OPENCUT_URL` to use
a different address. Projects and media persist in `agent/out/browser-profile`.

## Tools

| Tool | What it does |
|---|---|
| `open_project`, `new_project`, `list_projects`, `project_settings` | Projects; canvas size/fps (e.g. 1080x1920 vertical); `headed: true` shows the editor window |
| `get_timeline` | Tracks (index 0 = top layer), clips, ids, times, params |
| `import_media` | Add files to the media library (GIFs become video) |
| `add_clip` | Place video/image/GIF/audio from a path or media id, optionally a source range |
| `add_text` | Text overlay with position/style |
| `add_sound_effect` | Audio file at a time, with volume |
| `trim_clip`, `split_clip`, `move_clip`, `delete_clips` | Basic cutting |
| `set_properties` | Position, scale, rotation, opacity, blend mode, volume (dB), mute, text style |
| `animate` | Keyframes on scale/x/y/rotation/opacity/volume with easing |
| `zoom` | Zoom toward a point (in, hold, out) |
| `fade` | Fade in/out (opacity and/or volume) |
| `reorder_track`, `delete_track` | Layer order |
| `undo`, `redo` | History |
| `preview_frames` | Rendered stills at given times, without exporting |
| `export_video` | Render to .mp4/.webm, returns a contact sheet of the result |
| `cut_silences` | ffmpeg: remove silent stretches from raw footage |
| `contact_sheet` | Frame grid of any video |
| `transcribe_video` | Subtitles (.vtt) + word timings for a file; reuses existing transcripts |
| `find_words` | When words/phrases are spoken (transcribes first if needed) |
| `get_transcript` | What is said, with times, optionally within a range |
| `get_settings`, `set_settings` | Persistent settings (work folder, engine, model, port) |
| `media_server`, `publish_file`, `list_published`, `unpublish` | Host results over HTTP |
| `close_editor` | Save and close the browser |

Units: seconds everywhere; `x`/`y` are canvas pixels from the center; volume
in dB (0 = original, -60..20). Transcript times are in the source file.

## Settings and the work folder

Settings persist per user in `%APPDATA%/opencut-agent/config.json`
(`OPENCUT_AGENT_CONFIG` overrides the path). Generated files go in a flat work
folder (default `~/opencut-work`): `transcripts/`, `converted/` (GIFs),
`cuts/` (silence removal), `exports/`, `previews/`, `models/`.

## Transcripts

- Engines: `faster-whisper` (set `python` to an interpreter with
  `faster-whisper` installed; more accurate, per-word confidence) or ffmpeg's
  built-in `whisper.cpp` filter (no extra installs). `auto` picks
  faster-whisper when available. Models download into `<work>/models` on first
  use.
- `node setup-whisper.mjs [--model small.en] [--python <base python>]` creates
  `agent/.venv` with faster-whisper and points the settings at it.
- Names are deterministic: `<name>.vtt` + `<name>.words.json` next to the
  video, or `<name>.<fingerprint>.vtt` in `<work>/transcripts`. The fingerprint
  hashes size + first/last MiB, so renamed or copied files reuse the
  transcript. Lookup order: next to the video, then the work folder.
- `find_words` uses word timings when available and falls back to cue times for
  a hand-made `.vtt`.

## Media server

`node agent/serve.mjs [--port 8787]` runs it standalone; the MCP server starts
it in-process when nothing is listening on the configured port. Both read the
same registry (`<work>/published.json`), so either can serve what the other
published.

| Endpoint | |
|---|---|
| `/` | Gallery of published results, live-updating |
| `/api/artifacts` | JSON list with URLs |
| `/api/status` | Work folder, current project id, editor URL |
| `/events` | Server-sent events: fires whenever the registry changes |
| `/a/<id>/<file>` | The file, with byte ranges (seekable video) |
| `/editor` | Redirects to the OpenCut editor for the current project |

CORS is open so another local UI can embed or fetch anything.

## Driving an editor in your own app (remote control)

Load `http://localhost:8787/editor` in a panel (iframe, webview, any browser).
It redirects to the editor with `?control=…&token=…`; the page then connects
back to the media server and takes commands from it. While a panel is
connected, every editing tool drives that panel, so you watch edits happen and
can take over by hand. Nothing in your app is exposed; only the editor page
connects out.

- `editor_target` setting: `auto` (panel if connected, else headless),
  `panel` (fail without one) or `headless`.
- Files are imported by the page downloading them from the media server.
- The panel's browser keeps its own projects, separate from the headless one.
- The relay is token-protected (`<work>/control-token`). Any backend can use
  it, not just the MCP server:

| Endpoint | |
|---|---|
| `POST /control/call?token=` `{method, args}` | Run a bridge method (`getState`, `addText`, `trim`, …). Answers `{done, ok, result}` or, after ~25 s, `{done: false, id}` |
| `GET /control/wait?token=&id=` | Keep waiting for a long call (exports) |
| `GET /control/editors?token=` | Connected editors |

Methods and arguments are in `apps/web/src/agent-bridge/index.ts` (seconds
everywhere). The bridge exists only when the web app runs in development mode.

## Known limits

- GIF transparency is lost (the browser's video decoder drops alpha); use
  `blend_mode: "screen"` to hide a black background.
- No transition presets (wipes etc.); build crossfades from `fade` on
  overlapping clips.
- The main video track is the base layer and can't be reordered.

## Development

- `node test/make-media.mjs` generates synthetic test media into `out/media`
- `node test/make-speech.mjs` generates a spoken clip (Windows speech synthesis)
- `node test/mcp-e2e.mjs` runs a full edit through the MCP server
- `node test/panel-e2e.mjs` drives an editor opened in a separate browser
  through the remote-control relay
- `node test/transcript-e2e.mjs` checks transcription, word search and the
  media server (uses a throwaway settings file)
- `node smoke-test.mjs` exercises the Playwright client directly
