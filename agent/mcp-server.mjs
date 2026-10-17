#!/usr/bin/env node
// MCP server (stdio, JSON-RPC 2.0) exposing OpenCut editing as high-level tools.
// No SDK dependency: the stdio transport is newline-delimited JSON.
// Add to Claude Code:  claude mcp add opencut -- node <repo>/agent/mcp-server.mjs
import { createInterface } from "node:readline";
import { spawn, execFile } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./opencut.mjs";
import { contactSheet, convertGif, cutSilences, probe } from "./ffmpeg.mjs";
import {
	configPath,
	loadConfig,
	saveConfig,
	SETTING_DESCRIPTIONS,
	workDir,
} from "./config.mjs";
import {
	findTranscript,
	findWords,
	loadWords,
	resolveEngine,
	transcribe,
	wordsToCues,
} from "./transcribe.mjs";
import {
	listArtifacts,
	artifactUrl,
	publishArtifact,
	unpublishArtifact,
	writeSession,
} from "./artifacts.mjs";
import { isServing, startServer } from "./serve.mjs";

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(AGENT_DIR, "../apps/web");
const BASE_URL = process.env.OPENCUT_URL ?? "http://localhost:3000";
const PROTOCOL_VERSION = "2025-06-18";

const log = (...args) => console.error("[opencut-mcp]", ...args);

// ---------------------------------------------------------------- dev server

let devServer = null;

async function isUp() {
	try {
		await fetch(BASE_URL, { signal: AbortSignal.timeout(3000) });
		return true;
	} catch {
		return false;
	}
}

async function ensureDevServer() {
	if (await isUp()) return;
	if (!devServer) {
		log("starting dev server in", WEB_DIR);
		await mkdir(resolve(AGENT_DIR, "out"), { recursive: true });
		const logFile = openSync(resolve(AGENT_DIR, "out/dev-server.log"), "a");
		const port = new URL(BASE_URL).port || "3000";
		devServer = spawn(`npx next dev --turbopack -p ${port}`, {
			cwd: WEB_DIR,
			shell: true,
			stdio: ["ignore", logFile, logFile],
			windowsHide: true,
		});
		devServer.on("exit", () => (devServer = null));
	}
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		if (await isUp()) return;
		await new Promise((ok) => setTimeout(ok, 1500));
	}
	throw new Error(
		`Dev server did not come up at ${BASE_URL}; see agent/out/dev-server.log`,
	);
}

function stopDevServer() {
	if (!devServer?.pid) return;
	if (process.platform === "win32") {
		execFile("taskkill", ["/PID", String(devServer.pid), "/T", "/F"], () => {});
	} else {
		devServer.kill();
	}
}

// -------------------------------------------------------------- media server

let mediaServer = null;

/** Starts the media server in-process unless one already answers the port. */
async function ensureMediaServer(port = loadConfig().server_port) {
	if (!port) return null;
	if (mediaServer?.port === port) return mediaServer.url;
	if (await isServing(port)) return `http://localhost:${port}`;
	mediaServer?.close();
	mediaServer = await startServer({ port });
	log("media server on", mediaServer.url);
	return mediaServer.url;
}

function publish(path, options) {
	const artifact = publishArtifact(path, options);
	return { id: artifact.id, url: artifact.url, path: artifact.path };
}

// ------------------------------------------------------------------- session

let session = null;
let sessionHeaded = false;

async function recordSession(editor) {
	const state = await editor.getState();
	writeSession({ project_id: state.projectId, headed: sessionHeaded, editor_base: BASE_URL });
	return state;
}

async function getSession({ headed, projectId } = {}) {
	if (session && headed !== undefined && headed !== sessionHeaded) {
		await closeSession();
	}
	if (!session) {
		await ensureDevServer();
		sessionHeaded = headed ?? false;
		session = await launch({
			baseUrl: BASE_URL,
			projectId,
			headless: !sessionHeaded,
		});
		session.page.on("close", () => (session = null));
	} else if (projectId) {
		await session.save().catch(() => {});
		await session.openProject(projectId);
	}
	return session;
}

async function closeSession() {
	if (!session) return;
	await session.save().catch(() => {});
	await session.close().catch(() => {});
	session = null;
}

// ------------------------------------------------------------------- helpers

const EASING = { ease: "bezier", linear: "linear", hold: "hold" };

const PROPERTY_PATHS = {
	x: ["transform.positionX"],
	y: ["transform.positionY"],
	scale: ["transform.scaleX", "transform.scaleY"],
	scale_x: ["transform.scaleX"],
	scale_y: ["transform.scaleY"],
	rotation: ["transform.rotate"],
	opacity: ["opacity"],
	volume_db: ["volume"],
};

function pathsFor(property) {
	return PROPERTY_PATHS[property] ?? [property];
}

/** Maps friendly property names to editor params. */
function toParams(props = {}) {
	const params = {};
	const set = (paths, value) => {
		if (value === undefined) return;
		for (const path of paths) params[path] = value;
	};
	for (const [key, paths] of Object.entries(PROPERTY_PATHS)) {
		set(paths, props[key]);
	}
	if (props.muted !== undefined) params.muted = props.muted;
	if (props.blend_mode !== undefined) params.blendMode = props.blend_mode;
	if (props.text !== undefined) params.content = props.text;
	if (props.font_size !== undefined) params.fontSize = props.font_size;
	if (props.font_family !== undefined) params.fontFamily = props.font_family;
	if (props.font_weight !== undefined) params.fontWeight = props.font_weight;
	if (props.color !== undefined) params.color = props.color;
	if (props.align !== undefined) params.textAlign = props.align;
	if (props.background_color !== undefined) {
		params["background.enabled"] = props.background_color !== null;
		if (props.background_color) params["background.color"] = props.background_color;
	}
	Object.assign(params, props.params ?? {});
	return params;
}

function placementFor({ track = "auto", track_index }) {
	if (track === "auto") return {};
	if (track === "new") return { newTrack: true, trackIndex: track_index };
	return { trackId: track };
}

async function importPaths(editor, paths, { minDuration } = {}) {
	const prepared = [];
	const notes = [];
	for (const raw of paths) {
		const path = resolve(raw);
		if (!existsSync(path)) throw new Error(`File not found: ${path}`);
		if (extname(path).toLowerCase() === ".gif") {
			const converted = await convertGif(path, {
				minDuration,
				outputDir: workDir("converted"),
			});
			notes.push(`${path} -> ${converted} (GIFs are converted to video)`);
			prepared.push(converted);
		} else {
			prepared.push(path);
		}
	}
	const media = await editor.importFiles(prepared);
	return { media, notes };
}

async function resolveMedia(editor, { media_id, path, duration }) {
	if (media_id) {
		const { media } = await editor.getState();
		const asset = media.find((m) => m.id === media_id);
		if (!asset) throw new Error(`Media not found: ${media_id}`);
		return asset;
	}
	if (!path) throw new Error("Provide media_id or path");
	const { media } = await importPaths(editor, [path], { minDuration: duration });
	if (!media[0]) throw new Error(`Import failed for ${path}`);
	return media[0];
}

function summarize(element) {
	return {
		element_id: element.id,
		type: element.type,
		name: element.name,
		start: element.start,
		end: +(element.start + element.duration).toFixed(3),
		duration: element.duration,
		source_in: element.trimStart,
		source_out:
			element.sourceDuration !== undefined
				? +(element.sourceDuration - element.trimEnd).toFixed(3)
				: undefined,
	};
}

async function placedSummary(editor, placed) {
	const element = await editor.getElement({ elementId: placed.elementId });
	return { ...summarize(element), track_id: placed.trackId };
}

function toLocalTime(element, at) {
	const local = at - element.start;
	if (local < -1e-6 || local > element.duration + 1e-6) {
		throw new Error(
			`Time ${at}s is outside the clip (${element.start}s-${element.start + element.duration}s)`,
		);
	}
	return Math.min(Math.max(local, 0), element.duration);
}

const text = (value) => ({
	content: [
		{
			type: "text",
			text: typeof value === "string" ? value : JSON.stringify(value, null, 1),
		},
	],
});

// --------------------------------------------------------------------- tools

const num = (description) => ({ type: "number", description });
const str = (description) => ({ type: "string", description });
const bool = (description) => ({ type: "boolean", description });
const trackProp = {
	type: "string",
	description:
		'"auto" (first free compatible track), "new" (create a track), or an existing track_id',
};
const trackIndexProp = num(
	'Only with track="new": position in the overlay stack, 0 = top layer',
);
const easingProp = {
	type: "string",
	enum: ["ease", "linear", "hold"],
	description: "ease = smooth in/out (default), linear = constant speed, hold = jump",
};
const visualProps = {
	x: num("Horizontal offset from canvas center, in canvas pixels (+ = right)"),
	y: num("Vertical offset from canvas center, in canvas pixels (+ = down)"),
	scale: num("Uniform scale, 1 = fit to canvas"),
	rotation: num("Degrees"),
	opacity: num("0..1"),
	blend_mode: {
		type: "string",
		enum: ["normal", "screen", "multiply", "lighten", "darken", "overlay", "soft-light", "hard-light", "difference", "plus-lighter", "color-dodge", "color-burn", "exclusion", "hue", "saturation", "color", "luminosity"],
		description:
			"How the clip mixes with layers below. 'screen' hides black backgrounds (use for GIFs: their transparency becomes black).",
	},
};
const textProps = {
	font_size: num("Default 15; scaled to the canvas, ~20 is a large title"),
	font_family: str("e.g. Arial, Inter, Roboto"),
	font_weight: { type: "string", enum: ["normal", "bold"] },
	color: str("CSS hex color, e.g. #ffffff"),
	align: { type: "string", enum: ["left", "center", "right"] },
	background_color: str("Hex color for a box behind the text; omit for none"),
};

const tools = [
	{
		name: "open_project",
		description:
			"Start the editor and open a project. Without project_id it keeps the current project, or creates a new one on first use (use new_project to start another). Starts the dev server and browser if needed. headed=true opens a visible editor window you can watch and edit by hand.",
		inputSchema: {
			type: "object",
			properties: {
				project_id: str("Existing project id from list_projects"),
				name: str("Rename the project to this"),
				headed: bool("Show the editor window (default false = headless)"),
			},
		},
		async handler({ project_id, name, headed }) {
			const editor = await getSession({ headed, projectId: project_id });
			if (name) await editor.renameProject({ name });
			const state = await recordSession(editor);
			const server = await ensureMediaServer().catch(() => null);
			return text({
				project_id: state.projectId,
				editor_url: `${BASE_URL}/editor/${state.projectId}`,
				media_server: server,
				canvas: state.canvasSize,
				fps: state.fps,
				duration: state.duration,
				tracks: state.tracks.length,
				media: state.media.length,
			});
		},
	},
	{
		name: "new_project",
		description: "Save the current project and start a fresh, empty one.",
		inputSchema: {
			type: "object",
			properties: { name: str("Project name") },
		},
		async handler({ name }) {
			const editor = await getSession();
			await editor.save().catch(() => {});
			await editor.openProject();
			if (name) await editor.renameProject({ name });
			const state = await recordSession(editor);
			return text({ project_id: state.projectId, canvas: state.canvasSize });
		},
	},
	{
		name: "list_projects",
		description: "List saved projects (id, name, duration, last update).",
		inputSchema: { type: "object", properties: {} },
		async handler() {
			return text(await (await getSession()).listProjects());
		},
	},
	{
		name: "project_settings",
		description:
			"Change canvas size and/or frame rate, e.g. width=1080 height=1920 for vertical video.",
		inputSchema: {
			type: "object",
			properties: {
				width: num("Canvas width in pixels"),
				height: num("Canvas height in pixels"),
				fps: num("Frames per second"),
				name: str("Rename the project"),
			},
		},
		async handler({ width, height, fps, name }) {
			const editor = await getSession();
			if (name) await editor.renameProject({ name });
			return text(await editor.updateSettings({ width, height, fps }));
		},
	},
	{
		name: "get_timeline",
		description:
			"Current project state: canvas, duration, media library, and every track (index 0 = top layer) with its clips (ids, start/end, source range, params, animated properties).",
		inputSchema: { type: "object", properties: {} },
		async handler() {
			const state = await (await getSession()).getState();
			return text({
				...state,
				tracks: state.tracks.map((track) => ({
					...track,
					elements: track.elements.map((element) => ({
						...summarize(element),
						params: element.params,
						animated: element.animatedPaths,
					})),
				})),
			});
		},
	},
	{
		name: "import_media",
		description:
			"Add local files (video, audio, image, GIF) to the project's media library without placing them. Returns media ids. GIFs are converted to video so they animate.",
		inputSchema: {
			type: "object",
			properties: {
				paths: { type: "array", items: { type: "string" }, description: "Absolute file paths" },
			},
			required: ["paths"],
		},
		async handler({ paths }) {
			return text(await importPaths(await getSession(), paths));
		},
	},
	{
		name: "add_clip",
		description:
			"Place video, image, GIF or audio on the timeline. Pass a file path (imported automatically) or a media_id. Optionally use only part of the source with source_in/source_out. Video/images go on video tracks, audio on audio tracks.",
		inputSchema: {
			type: "object",
			properties: {
				path: str("Local file path (imported automatically)"),
				media_id: str("Media id from import_media / get_timeline"),
				start: num("Timeline time in seconds where the clip begins"),
				duration: num("Seconds on the timeline; images default to 5s, media to full length"),
				source_in: num("Seconds into the source to start from"),
				source_out: num("Seconds into the source to stop at"),
				track: trackProp,
				track_index: trackIndexProp,
				...visualProps,
				volume_db: num("Clip volume in dB (-60..20, 0 = unchanged)"),
			},
			required: ["start"],
		},
		async handler(args) {
			const editor = await getSession();
			const asset = await resolveMedia(editor, args);
			// Video/audio can't run past the end of the source (it would freeze).
			const available =
				asset.duration != null ? asset.duration - (args.source_in ?? 0) : undefined;
			const duration =
				args.duration !== undefined && available !== undefined
					? Math.min(args.duration, available)
					: args.duration;
			const placed = await editor.addMedia({
				mediaId: asset.id,
				start: args.start,
				duration,
				placement: placementFor(args),
			});
			if (args.source_in !== undefined || args.source_out !== undefined) {
				const element = await editor.getElement({ elementId: placed.elementId });
				await editor.trim({
					elementId: placed.elementId,
					sourceIn: args.source_in ?? 0,
					sourceOut: args.source_out ?? element.sourceDuration,
					start: args.start,
				});
			}
			const params = toParams(args);
			if (Object.keys(params).length) {
				await editor.setParams({ elementId: placed.elementId, params });
			}
			const summary = await placedSummary(editor, placed);
			if (duration !== args.duration) {
				summary.note = `duration capped to ${duration}s: the source only has that much after source_in`;
			}
			return text(summary);
		},
	},
	{
		name: "add_text",
		description:
			"Add a text overlay for a time range. Use position for quick placement or x/y for exact offsets.",
		inputSchema: {
			type: "object",
			properties: {
				text: str("The text to show"),
				start: num("Timeline seconds"),
				duration: num("Seconds on screen"),
				position: {
					type: "string",
					enum: ["top", "center", "bottom"],
					description: "Shortcut for y; overridden by y",
				},
				track: trackProp,
				track_index: trackIndexProp,
				...textProps,
				...visualProps,
			},
			required: ["text", "start", "duration"],
		},
		async handler(args) {
			const editor = await getSession();
			const state = await editor.getState();
			const y =
				args.y ??
				{ top: -0.36, center: 0, bottom: 0.36 }[args.position ?? "center"] *
					state.canvasSize.height;
			const params = toParams({ ...args, y, text: undefined });
			const placed = await editor.addText({
				text: args.text,
				start: args.start,
				duration: args.duration,
				params,
				placement: placementFor(args),
			});
			return text(await placedSummary(editor, placed));
		},
	},
	{
		name: "add_sound_effect",
		description:
			"Drop an audio file (sound effect, music) on the timeline at a time, on an audio track.",
		inputSchema: {
			type: "object",
			properties: {
				path: str("Local audio file path"),
				media_id: str("Media id if already imported"),
				at: num("Timeline seconds"),
				volume_db: num("dB, -60..20 (0 = unchanged)"),
				duration: num("Cut the sound off after this many seconds"),
				track: trackProp,
			},
			required: ["at"],
		},
		async handler(args) {
			const editor = await getSession();
			const asset = await resolveMedia(editor, { ...args, duration: undefined });
			const placed = await editor.addMedia({
				mediaId: asset.id,
				start: args.at,
				placement: placementFor(args),
			});
			if (args.duration !== undefined) {
				await editor.trim({
					elementId: placed.elementId,
					sourceIn: 0,
					sourceOut: args.duration,
				});
			}
			if (args.volume_db !== undefined) {
				await editor.setVolume({ elementId: placed.elementId, db: args.volume_db });
			}
			return text(await placedSummary(editor, placed));
		},
	},
	{
		name: "trim_clip",
		description:
			"Show only source_in..source_out of a clip's source media (seconds within the source file, not the timeline). Optionally move it to a new start.",
		inputSchema: {
			type: "object",
			properties: {
				element_id: str("Clip id"),
				source_in: num("Seconds into the source"),
				source_out: num("Seconds into the source"),
				start: num("New timeline start (optional)"),
			},
			required: ["element_id", "source_in", "source_out"],
		},
		async handler({ element_id, source_in, source_out, start }) {
			const editor = await getSession();
			return text(
				summarize(
					await editor.trim({
						elementId: element_id,
						sourceIn: source_in,
						sourceOut: source_out,
						start,
					}),
				),
			);
		},
	},
	{
		name: "split_clip",
		description:
			"Cut clips in two at a timeline time. Returns the ids of the right-hand pieces. To remove a section: split at its start and end, then delete the middle piece.",
		inputSchema: {
			type: "object",
			properties: {
				element_ids: { type: "array", items: { type: "string" } },
				at: num("Timeline seconds"),
			},
			required: ["element_ids", "at"],
		},
		async handler({ element_ids, at }) {
			return text(await (await getSession()).split({ elementIds: element_ids, at }));
		},
	},
	{
		name: "move_clip",
		description: "Move a clip to a new start time and/or another compatible track.",
		inputSchema: {
			type: "object",
			properties: {
				element_id: str("Clip id"),
				start: num("New timeline start in seconds"),
				track_id: str("Destination track (optional)"),
			},
			required: ["element_id", "start"],
		},
		async handler({ element_id, start, track_id }) {
			const editor = await getSession();
			return text(
				summarize(await editor.move({ elementId: element_id, start, trackId: track_id })),
			);
		},
	},
	{
		name: "delete_clips",
		description: "Remove clips from the timeline. Tracks left empty disappear.",
		inputSchema: {
			type: "object",
			properties: { element_ids: { type: "array", items: { type: "string" } } },
			required: ["element_ids"],
		},
		async handler({ element_ids }) {
			await (await getSession()).remove({ elementIds: element_ids });
			return text("deleted");
		},
	},
	{
		name: "set_properties",
		description:
			"Set static (non-animated) properties on a clip: position, scale, rotation, opacity, volume, mute, and text styling. For changes over time use animate/zoom/fade.",
		inputSchema: {
			type: "object",
			properties: {
				element_id: str("Clip id"),
				...visualProps,
				volume_db: num("dB, -60..20; e.g. 4 to boost a quiet voice, -12 for background music"),
				muted: bool("Mute this clip"),
				text: str("Replace text content"),
				...textProps,
				params: { type: "object", description: "Raw editor params, for anything not covered above" },
			},
			required: ["element_id"],
		},
		async handler(args) {
			const editor = await getSession();
			const element = await editor.setParams({
				elementId: args.element_id,
				params: toParams(args),
			});
			return text({ ...summarize(element), params: element.params });
		},
	},
	{
		name: "animate",
		description:
			"Keyframe a property over time. Each keyframe gives a timeline time and a value; the editor interpolates between them (easing applies to the motion leaving each keyframe). Properties: scale, x, y, rotation, opacity, volume_db, or a raw param path.",
		inputSchema: {
			type: "object",
			properties: {
				element_id: str("Clip id"),
				property: str("scale | x | y | rotation | opacity | volume_db | scale_x | scale_y | <param path>"),
				keyframes: {
					type: "array",
					items: {
						type: "object",
						properties: {
							at: num("Timeline seconds (within the clip)"),
							value: { description: "Number (or color string for color params)" },
							easing: easingProp,
						},
						required: ["at", "value"],
					},
				},
			},
			required: ["element_id", "property", "keyframes"],
		},
		async handler({ element_id, property, keyframes }) {
			const editor = await getSession();
			const element = await editor.getElement({ elementId: element_id });
			for (const path of pathsFor(property)) {
				await editor.setKeyframes({
					elementId: element_id,
					path,
					keyframes: keyframes.map(({ at, value, easing = "ease" }) => ({
						time: toLocalTime(element, at),
						value,
						interpolation: EASING[easing],
					})),
				});
			}
			return text(`set ${keyframes.length} keyframes on ${property}`);
		},
	},
	{
		name: "zoom",
		description:
			"Smoothly zoom a clip toward a point: ramps in starting at `start`, holds, and ramps back out to finish at `end` (unless zoom_out=false). focus_x/focus_y pick the point that stays fixed, as fractions of the frame (0,0 = top-left, 0.5,0.5 = center).",
		inputSchema: {
			type: "object",
			properties: {
				element_id: str("Clip id"),
				start: num("Timeline seconds the zoom-in begins"),
				end: num("Timeline seconds the zoom-out finishes"),
				scale: num("Zoom factor relative to the clip's current scale, e.g. 1.5"),
				focus_x: num("0..1 across the frame, default 0.5"),
				focus_y: num("0..1 down the frame, default 0.5"),
				ramp: num("Seconds each zoom transition takes, default 0.5"),
				zoom_out: bool("Return to normal at `end` (default true)"),
				easing: easingProp,
			},
			required: ["element_id", "start", "end", "scale"],
		},
		async handler({
			element_id,
			start,
			end,
			scale,
			focus_x = 0.5,
			focus_y = 0.5,
			ramp = 0.5,
			zoom_out = true,
			easing = "ease",
		}) {
			const editor = await getSession();
			const element = await editor.getElement({ elementId: element_id });
			const { canvasSize } = await editor.getState();
			if (end - start < ramp * (zoom_out ? 2 : 1)) {
				throw new Error("start..end is too short for the ramp; shorten ramp or widen the range");
			}

			const p = element.params;
			const baseScaleX = p["transform.scaleX"] ?? 1;
			const baseScaleY = p["transform.scaleY"] ?? 1;
			const baseX = p["transform.positionX"] ?? 0;
			const baseY = p["transform.positionY"] ?? 0;
			// Keep the focus point fixed on screen: offset the position by how far
			// the point sits from the clip's center, times the extra scale.
			const focusX = focus_x * canvasSize.width - (canvasSize.width / 2 + baseX);
			const focusY = focus_y * canvasSize.height - (canvasSize.height / 2 + baseY);
			const zoomed = {
				"transform.scaleX": baseScaleX * scale,
				"transform.scaleY": baseScaleY * scale,
				"transform.positionX": baseX + focusX * (1 - scale),
				"transform.positionY": baseY + focusY * (1 - scale),
			};
			const base = {
				"transform.scaleX": baseScaleX,
				"transform.scaleY": baseScaleY,
				"transform.positionX": baseX,
				"transform.positionY": baseY,
			};

			const times = zoom_out
				? [
						[start, base, EASING[easing]],
						[start + ramp, zoomed, "linear"],
						[end - ramp, zoomed, EASING[easing]],
						[end, base, "linear"],
					]
				: [
						[start, base, EASING[easing]],
						[start + ramp, zoomed, "linear"],
					];
			for (const path of Object.keys(base)) {
				await editor.setKeyframes({
					elementId: element_id,
					path,
					keyframes: times.map(([at, values, interpolation]) => ({
						time: toLocalTime(element, at),
						value: values[path],
						interpolation,
					})),
				});
			}
			return text({ zoomed_values: zoomed, keyframe_times: times.map(([at]) => at) });
		},
	},
	{
		name: "fade",
		description:
			"Fade a clip in and/or out. Visual clips fade opacity, audio clips fade volume; video does both unless `what` says otherwise.",
		inputSchema: {
			type: "object",
			properties: {
				element_id: str("Clip id"),
				fade_in: num("Seconds of fade at the start"),
				fade_out: num("Seconds of fade at the end"),
				what: { type: "string", enum: ["auto", "video", "audio", "both"] },
			},
			required: ["element_id"],
		},
		async handler({ element_id, fade_in = 0, fade_out = 0, what = "auto" }) {
			const editor = await getSession();
			const element = await editor.getElement({ elementId: element_id });
			const hasOpacity = "opacity" in element.params;
			const hasVolume = "volume" in element.params;
			const doVideo = what === "auto" ? hasOpacity : what !== "audio";
			const doAudio = what === "auto" ? hasVolume : what !== "video";
			const end = element.duration;
			const ramp = (low, high) => [
				...(fade_in > 0
					? [
							{ time: 0, value: low, interpolation: "linear" },
							{ time: fade_in, value: high, interpolation: "linear" },
						]
					: []),
				...(fade_out > 0
					? [
							{ time: end - fade_out, value: high, interpolation: "linear" },
							{ time: end, value: low, interpolation: "linear" },
						]
					: []),
			];
			const done = [];
			if (doVideo && hasOpacity) {
				await editor.setKeyframes({
					elementId: element_id,
					path: "opacity",
					keyframes: ramp(0, element.params.opacity ?? 1),
				});
				done.push("opacity");
			}
			if (doAudio && hasVolume) {
				await editor.setKeyframes({
					elementId: element_id,
					path: "volume",
					keyframes: ramp(-60, element.params.volume ?? 0),
				});
				done.push("volume");
			}
			return text(`faded ${done.join(" + ") || "nothing (clip has no opacity/volume)"}`);
		},
	},
	{
		name: "reorder_track",
		description:
			"Move a track up/down the layer stack. Overlay tracks: index 0 is the top layer. The main video track is fixed; audio tracks reorder among themselves.",
		inputSchema: {
			type: "object",
			properties: {
				track_id: str("Track id"),
				to_index: num("New index within its group (overlay or audio)"),
			},
			required: ["track_id", "to_index"],
		},
		async handler({ track_id, to_index }) {
			const tracks = await (await getSession()).reorderTrack({
				trackId: track_id,
				toIndex: to_index,
			});
			return text(tracks.map((t) => ({ index: t.index, id: t.id, type: t.type, clips: t.elements.length })));
		},
	},
	{
		name: "delete_track",
		description: "Delete a track and everything on it.",
		inputSchema: {
			type: "object",
			properties: { track_id: str("Track id") },
			required: ["track_id"],
		},
		async handler({ track_id }) {
			await (await getSession()).removeTrack({ trackId: track_id });
			return text("deleted");
		},
	},
	{
		name: "undo",
		description: "Undo the last edit (repeat with count).",
		inputSchema: { type: "object", properties: { count: num("Default 1") } },
		async handler({ count = 1 }) {
			const editor = await getSession();
			for (let i = 0; i < count; i++) await editor.undo();
			return text(`undid ${count}`);
		},
	},
	{
		name: "redo",
		description: "Redo the last undone edit (repeat with count).",
		inputSchema: { type: "object", properties: { count: num("Default 1") } },
		async handler({ count = 1 }) {
			const editor = await getSession();
			for (let i = 0; i < count; i++) await editor.redo();
			return text(`redid ${count}`);
		},
	},
	{
		name: "preview_frames",
		description:
			"Render what the timeline looks like at given times and return the images. Use this to check edits without exporting.",
		inputSchema: {
			type: "object",
			properties: {
				times: { type: "array", items: { type: "number" }, description: "Timeline seconds (max 6)" },
				width: num("Image width, default 640"),
				publish: bool("Also save the frames and host them on the media server"),
			},
			required: ["times"],
		},
		async handler({ times, width = 640, publish: shouldPublish = false }) {
			const editor = await getSession();
			const content = [];
			const projectId = shouldPublish ? (await editor.getState()).projectId.slice(0, 8) : null;
			for (const time of times.slice(0, 6)) {
				const data = await editor.renderFrame({ time, width });
				let label = `t=${time}s`;
				if (shouldPublish) {
					const file = join(workDir("previews"), `${projectId}-t${time}.jpg`);
					await writeFile(file, Buffer.from(data, "base64"));
					await ensureMediaServer().catch(() => null);
					label += ` ${publish(file, { title: `Preview ${time}s` }).url}`;
				}
				content.push({ type: "text", text: label });
				content.push({ type: "image", mimeType: "image/jpeg", data });
			}
			return { content };
		},
	},
	{
		name: "export_video",
		description:
			"Render the project to a video file and publish it on the media server. Returns path, URL, size, duration, and (by default) a contact sheet of evenly spaced frames to check the result.",
		inputSchema: {
			type: "object",
			properties: {
				path: str("Output path (.mp4 or .webm); default <work folder>/exports/<project>-<time>.mp4"),
				title: str("Title shown in the media server gallery"),
				quality: { type: "string", enum: ["low", "medium", "high", "very_high"] },
				include_audio: bool("Default true"),
				contact_sheet: bool("Return a frame grid of the result (default true)"),
			},
		},
		async handler({ path, title, quality = "high", include_audio = true, contact_sheet = true }) {
			const editor = await getSession();
			const state = await editor.getState();
			const target = path
				? resolve(path)
				: join(
						workDir("exports"),
						`${state.projectId.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`,
					);
			const format = extname(target).toLowerCase() === ".webm" ? "webm" : "mp4";
			const result = await editor.exportTo(target, {
				format,
				quality,
				includeAudio: include_audio,
			});
			const info = await probe(result.path);
			await ensureMediaServer().catch(() => null);
			const published = publish(result.path, {
				title,
				meta: { project_id: state.projectId, duration: info.duration },
			});
			const content = [
				{
					type: "text",
					text: JSON.stringify({
						...result,
						url: published.url,
						duration: info.duration,
						has_audio: info.hasAudio,
					}),
				},
			];
			if (contact_sheet) {
				const sheet = await contactSheet(result.path);
				content.push({ type: "text", text: `frames at ${sheet.times.join(", ")}s` });
				content.push({ type: "image", mimeType: "image/png", data: sheet.png });
			}
			return { content };
		},
	},
	{
		name: "cut_silences",
		description:
			"Outside the editor (ffmpeg): remove silent stretches from a recording and write a new file. Run on raw footage before add_clip. dry_run=true only reports what would be cut.",
		inputSchema: {
			type: "object",
			properties: {
				input: str("Source video/audio path"),
				output: str("Output path (default <work folder>/cuts/<name>.nosilence.<ext>)"),
				threshold_db: num("Quieter than this counts as silence, default -35"),
				min_silence: num("Only cut silences at least this long (s), default 0.5"),
				padding: num("Seconds of silence kept next to speech, default 0.15"),
				dry_run: bool("Report cuts without writing a file"),
			},
			required: ["input"],
		},
		async handler({ input, output, threshold_db, min_silence, padding, dry_run }) {
			const stem = basename(input, extname(input));
			const result = await cutSilences(input, {
				output: output ?? join(workDir("cuts"), `${stem}.nosilence${extname(input)}`),
				thresholdDb: threshold_db,
				minSilence: min_silence,
				padding,
				dryRun: dry_run,
			});
			if (result.output) {
				await ensureMediaServer().catch(() => null);
				result.url = publish(result.output, { title: `${stem} (silences cut)` }).url;
			}
			return text(result);
		},
	},
	{
		name: "contact_sheet",
		description: "Show a grid of evenly spaced frames from any video file.",
		inputSchema: {
			type: "object",
			properties: {
				path: str("Video path"),
				frames: num("Number of frames, default 12, max 36"),
			},
			required: ["path"],
		},
		async handler({ path, frames }) {
			const sheet = await contactSheet(resolve(path), { frames });
			return {
				content: [
					{ type: "text", text: `duration ${sheet.duration}s; frames at ${sheet.times.join(", ")}s` },
					{ type: "image", mimeType: "image/png", data: sheet.png },
				],
			};
		},
	},
	{
		name: "get_settings",
		description:
			"Show persistent settings (work folder, transcript location, transcription engine/model, media server port) and where they are stored. Settings persist across sessions.",
		inputSchema: { type: "object", properties: {} },
		async handler() {
			return text({
				settings: loadConfig(),
				descriptions: SETTING_DESCRIPTIONS,
				stored_at: configPath(),
				transcription_engine_in_use: await resolveEngine().catch((e) => `error: ${e.message}`),
			});
		},
	},
	{
		name: "set_settings",
		description:
			"Change persistent settings. work_folder is the flat folder where generated files live (transcripts, converted media, exports); it is reused across sessions.",
		inputSchema: {
			type: "object",
			properties: {
				work_folder: str(SETTING_DESCRIPTIONS.work_folder),
				transcript_location: {
					type: "string",
					enum: ["work_folder", "next_to_video"],
					description: SETTING_DESCRIPTIONS.transcript_location,
				},
				transcription_engine: {
					type: "string",
					enum: ["auto", "faster-whisper", "whisper.cpp"],
					description: SETTING_DESCRIPTIONS.transcription_engine,
				},
				python: str(SETTING_DESCRIPTIONS.python),
				whisper_model: str(SETTING_DESCRIPTIONS.whisper_model),
				language: str(SETTING_DESCRIPTIONS.language),
				keep_fillers: bool(SETTING_DESCRIPTIONS.keep_fillers),
				server_port: num(SETTING_DESCRIPTIONS.server_port),
			},
		},
		async handler(args) {
			const settings = saveConfig(args);
			if (args.server_port !== undefined) await ensureMediaServer(settings.server_port);
			return text({ settings, stored_at: configPath() });
		},
	},
	{
		name: "transcribe_video",
		description:
			"Generate subtitles (.vtt) and word timings for a video/audio file. Reuses an existing transcript (next to the file or in the work folder) unless force=true. Files are named deterministically: <name>.vtt beside the video, or <name>.<fingerprint>.vtt in <work folder>/transcripts.",
		inputSchema: {
			type: "object",
			properties: {
				path: str("Video or audio file"),
				force: bool("Re-transcribe even if a transcript exists"),
				location: {
					type: "string",
					enum: ["work_folder", "next_to_video"],
					description: "Where to write; default from settings",
				},
				model: str("Override the model for this run"),
				language: str("Override the language for this run"),
			},
			required: ["path"],
		},
		async handler({ path, force, location, model, language }) {
			const result = await transcribe(path, { force, location, model, language });
			if (result.vtt) {
				await ensureMediaServer().catch(() => null);
				result.url = publish(result.vtt, { title: `${basename(path)} subtitles` }).url;
			}
			return text(result);
		},
	},
	{
		name: "find_words",
		description:
			"Find when words or phrases are spoken in a video. Uses the existing transcript, transcribing first if there is none. Matching ignores case and punctuation. Returns start/end seconds (in the source file) and surrounding words for each occurrence.",
		inputSchema: {
			type: "object",
			properties: {
				path: str("Video or audio file"),
				phrases: {
					type: "array",
					items: { type: "string" },
					description: 'Words or phrases, e.g. ["sound effect", "thanks for watching"]',
				},
				context: num("Words of context on each side (default 6)"),
			},
			required: ["path", "phrases"],
		},
		async handler({ path, phrases, context }) {
			return text(await findWords(path, phrases, { context }));
		},
	},
	{
		name: "get_transcript",
		description:
			"Read what is said in a video, with timestamps, optionally only within start..end seconds. Transcribes first if needed. format=cues gives subtitle lines; words gives each word.",
		inputSchema: {
			type: "object",
			properties: {
				path: str("Video or audio file"),
				start: num("From this many seconds"),
				end: num("Up to this many seconds"),
				format: { type: "string", enum: ["cues", "words"] },
			},
			required: ["path"],
		},
		async handler({ path, start = 0, end = Infinity, format = "cues" }) {
			let transcript = await findTranscript(path);
			if (!transcript) transcript = await transcribe(path);
			const { precision, words, cues } = await loadWords(transcript);
			const inRange = (item) => item.end > start && item.start < end;
			const items =
				format === "words"
					? words.filter(inRange)
					: (cues ?? wordsToCues(words)).filter(inRange);
			return text({
				transcript: transcript.vtt ?? transcript.words,
				precision,
				[format]: items.map((item) => ({
					start: item.start,
					end: item.end,
					...(format === "words" ? { word: item.word, prob: item.prob } : { text: item.text }),
				})),
			});
		},
	},
	{
		name: "media_server",
		description:
			"Start (if needed) the local media server and return its URLs: a gallery page, a JSON list of published results, a live update stream (SSE), and a redirect to the OpenCut editor for the current project. Use these URLs to show results in another UI.",
		inputSchema: {
			type: "object",
			properties: { port: num("Use this port (also saved as the default)") },
		},
		async handler({ port }) {
			if (port !== undefined) saveConfig({ server_port: port });
			const url = await ensureMediaServer(port ?? (loadConfig().server_port || 8787));
			return text({
				gallery: `${url}/`,
				artifacts_api: `${url}/api/artifacts`,
				status_api: `${url}/api/status`,
				events_sse: `${url}/events`,
				editor: `${url}/editor`,
				published: listArtifacts().length,
				running_in: mediaServer?.url === url ? "this MCP server" : "another process",
			});
		},
	},
	{
		name: "publish_file",
		description:
			"Host any local file on the media server (video, image, audio, VTT, JSON, HTML...) and get a URL. Republishing the same path keeps the same URL.",
		inputSchema: {
			type: "object",
			properties: {
				path: str("Local file"),
				title: str("Title for the gallery"),
			},
			required: ["path"],
		},
		async handler({ path, title }) {
			await ensureMediaServer().catch(() => null);
			return text(publish(path, { title }));
		},
	},
	{
		name: "list_published",
		description: "List files hosted on the media server, newest first, with URLs.",
		inputSchema: { type: "object", properties: {} },
		async handler() {
			return text(
				listArtifacts().map((a) => ({ id: a.id, title: a.title, kind: a.kind, url: artifactUrl(a), path: a.path })),
			);
		},
	},
	{
		name: "unpublish",
		description: "Stop hosting a published file (the file itself is kept).",
		inputSchema: {
			type: "object",
			properties: { id: str("Artifact id from list_published") },
			required: ["id"],
		},
		async handler({ id }) {
			unpublishArtifact(id);
			return text("unpublished");
		},
	},
	{
		name: "close_editor",
		description: "Save and close the browser (the dev server keeps running).",
		inputSchema: { type: "object", properties: {} },
		async handler() {
			await closeSession();
			return text("closed");
		},
	},
];

const INSTRUCTIONS = `OpenCut video editor tools. All times are in seconds.
Workflow: open_project -> (optional cut_silences on raw footage) -> add_clip / add_text / add_sound_effect -> trim_clip, set_properties, zoom, fade, animate -> preview_frames to check -> export_video.
Timeline: overlay tracks sit above the main video track; track index 0 is the top layer. Tracks with no clips are removed automatically, so create tracks by placing a clip with track="new".
Positions (x, y) are canvas pixels offset from the center; get_timeline shows the canvas size. Volume is in dB (0 = original).
Keyframe times are timeline times and must fall inside the clip.
Transcripts: transcribe_video / find_words / get_transcript work on source files (times are in the source, not the timeline). find_words is the fast way to locate where something is said; feed its times into source_in/source_out or split points.
Results: export_video, cut_silences and transcribe_video publish their output on the local media server (see media_server for URLs); publish_file hosts anything else. Generated files live in the work folder (get_settings / set_settings).`;

// ----------------------------------------------------------------- transport

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request) {
	const { id, method, params } = request;
	switch (method) {
		case "initialize":
			return {
				protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "opencut", version: "0.1.0" },
				instructions: INSTRUCTIONS,
			};
		case "ping":
			return {};
		case "tools/list":
			return {
				tools: tools.map(({ name, description, inputSchema }) => ({
					name,
					description,
					inputSchema,
				})),
			};
		case "tools/call": {
			const tool = tools.find((t) => t.name === params?.name);
			if (!tool) {
				throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: -32602 });
			}
			try {
				return await tool.handler(params.arguments ?? {});
			} catch (error) {
				log(tool.name, "failed:", error);
				const recent = session?.logs?.slice(-5).join("\n");
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `${error.message}${recent ? `\n\nRecent editor console:\n${recent}` : ""}`,
						},
					],
				};
			}
		}
		default:
			if (id === undefined) return undefined;
			throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
	}
}

// Tool calls run one at a time so edits apply in order.
let queue = Promise.resolve();

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		return;
	}
	queue = queue.then(async () => {
		try {
			const result = await handle(request);
			if (request.id !== undefined && result !== undefined) {
				send({ jsonrpc: "2.0", id: request.id, result });
			}
		} catch (error) {
			if (request.id !== undefined) {
				send({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: error.code ?? -32603, message: error.message },
				});
			}
		}
	});
});

async function shutdown() {
	await closeSession();
	mediaServer?.close();
	stopDevServer();
	process.exit(0);
}
process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
