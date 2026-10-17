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
| `close_editor` | Save and close the browser |

Units: seconds everywhere; `x`/`y` are canvas pixels from the center; volume
in dB (0 = original, -60..20).

## Known limits

- GIF transparency is lost (the browser's video decoder drops alpha); use
  `blend_mode: "screen"` to hide a black background.
- No transition presets (wipes etc.); build crossfades from `fade` on
  overlapping clips.
- The main video track is the base layer and can't be reordered.

## Development

- `node test/make-media.mjs` generates synthetic test media into `out/media`
- `node test/mcp-e2e.mjs` runs a full edit through the MCP server
- `node smoke-test.mjs` exercises the Playwright client directly
