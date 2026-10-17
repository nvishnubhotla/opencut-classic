import { EditorCore } from "@/core";
import { BatchCommand } from "@/commands";
import {
	AddTrackCommand,
	InsertElementCommand,
	TracksSnapshotCommand,
} from "@/commands/timeline";
import { processMediaAssets } from "@/media/processing";
import type { MediaAsset } from "@/media/types";
import {
	buildElementFromMedia,
	buildTextElement,
} from "@/timeline/element-utils";
import { DEFAULTS } from "@/timeline/defaults";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import type {
	CreateTimelineElement,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TrackType,
} from "@/timeline";
import type { AnimationInterpolation } from "@/animation/types";
import type { ParamValue } from "@/params";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	type MediaTime,
} from "@/wasm";

/**
 * Dev-only automation surface for driving the editor from Playwright/CDP.
 * Every time in and out of this module is in seconds; conversion to ticks
 * happens here so callers never see MediaTime.
 */

export const AGENT_FILE_INPUT_ID = "__opencut-agent-file-input";
const EXPORT_CHUNK_BYTES = 4 * 1024 * 1024;

type Placement =
	| { trackId: string }
	| { newTrack: true; trackIndex?: number }
	| Record<string, never>;

let lastExport: ArrayBuffer | null = null;

function editor(): EditorCore {
	return EditorCore.getInstance();
}

function ticks(seconds: number): MediaTime {
	return mediaTimeFromSeconds({ seconds });
}

function secs(time: MediaTime | undefined): number | undefined {
	return time === undefined ? undefined : mediaTimeToSeconds({ time });
}

function orderedTracks(tracks: SceneTracks): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

function findElement({ elementId }: { elementId: string }): {
	track: TimelineTrack;
	element: TimelineElement;
} {
	const tracks = editor().scenes.getActiveScene().tracks;
	for (const track of orderedTracks(tracks)) {
		const element = track.elements.find((el) => el.id === elementId);
		if (element) {
			return { track, element };
		}
	}
	throw new Error(`Element not found: ${elementId}`);
}

function describeElement(element: TimelineElement) {
	return {
		id: element.id,
		type: element.type,
		name: element.name,
		start: secs(element.startTime),
		duration: secs(element.duration),
		trimStart: secs(element.trimStart),
		trimEnd: secs(element.trimEnd),
		sourceDuration: secs(element.sourceDuration),
		mediaId: "mediaId" in element ? element.mediaId : undefined,
		params: element.params,
		animatedPaths: Object.keys(element.animations ?? {}),
	};
}

function insert({
	element,
	trackType,
	placement,
}: {
	element: CreateTimelineElement;
	trackType: TrackType;
	placement: Placement;
}): { elementId: string; trackId: string } {
	let insertCommand: InsertElementCommand;
	let command: InsertElementCommand | BatchCommand;

	if ("newTrack" in placement) {
		// Empty tracks are pruned after every command, so the track and its
		// first element must be created in the same command.
		const addTrack = new AddTrackCommand({
			type: trackType,
			index: placement.trackIndex,
		});
		insertCommand = new InsertElementCommand({
			element,
			placement: { mode: "explicit", trackId: addTrack.getTrackId() },
		});
		command = new BatchCommand([addTrack, insertCommand]);
	} else if ("trackId" in placement) {
		insertCommand = new InsertElementCommand({
			element,
			placement: { mode: "explicit", trackId: placement.trackId },
		});
		command = insertCommand;
	} else {
		insertCommand = new InsertElementCommand({
			element,
			placement: { mode: "auto", trackType },
		});
		command = insertCommand;
	}

	editor().command.execute({ command });
	const trackId = insertCommand.getTrackId();
	if (!trackId) {
		throw new Error(
			"Element could not be placed (incompatible track or overlapping element)",
		);
	}
	return { elementId: insertCommand.getElementId(), trackId };
}

function trackTypeForMedia(asset: MediaAsset): TrackType {
	return asset.type === "audio" ? "audio" : "video";
}

const agent = {
	isReady(): boolean {
		return editor().project.getActiveOrNull() !== null;
	},

	getState() {
		const project = editor().project.getActive();
		const tracks = editor().scenes.getActiveScene().tracks;
		return {
			projectId: project.metadata.id,
			fps: project.settings.fps,
			canvasSize: project.settings.canvasSize,
			duration: secs(editor().timeline.getTotalDuration()),
			media: editor()
				.media.getAssets()
				.map((asset) => ({
					id: asset.id,
					name: asset.name,
					type: asset.type,
					duration: asset.duration,
					width: asset.width,
					height: asset.height,
				})),
			tracks: orderedTracks(tracks).map((track, index) => ({
				index,
				id: track.id,
				type: track.type,
				name: track.name,
				isMain: track.id === tracks.main.id,
				muted: "muted" in track ? track.muted : undefined,
				hidden: "hidden" in track ? track.hidden : undefined,
				elements: track.elements.map(describeElement),
			})),
		};
	},

	getElement({ elementId }: { elementId: string }) {
		const { track, element } = findElement({ elementId });
		return {
			trackId: track.id,
			...describeElement(element),
			animations: element.animations,
		};
	},

	/** Imports the files currently selected in the hidden agent file input. */
	async importFiles() {
		const input = document.getElementById(
			AGENT_FILE_INPUT_ID,
		) as HTMLInputElement | null;
		const files = Array.from(input?.files ?? []);
		if (files.length === 0) {
			throw new Error("No files selected in the agent file input");
		}

		const projectId = editor().project.getActive().metadata.id;
		const processed = await processMediaAssets({ files });
		const imported = [];
		for (const asset of processed) {
			const saved = await editor().media.addMediaAsset({ projectId, asset });
			if (saved) {
				imported.push({
					id: saved.id,
					name: saved.name,
					type: saved.type,
					duration: saved.duration,
					width: saved.width,
					height: saved.height,
				});
			}
		}
		if (input) {
			input.value = "";
		}
		return imported;
	},

	addMedia({
		mediaId,
		start,
		duration,
		placement = {},
	}: {
		mediaId: string;
		start: number;
		duration?: number;
		placement?: Placement;
	}) {
		const asset = editor()
			.media.getAssets()
			.find((candidate) => candidate.id === mediaId);
		if (!asset) {
			throw new Error(`Media not found: ${mediaId}`);
		}

		const element = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration:
				duration !== undefined
					? ticks(duration)
					: asset.duration != null
						? ticks(asset.duration)
						: DEFAULT_NEW_ELEMENT_DURATION,
			startTime: ticks(start),
		});
		return insert({
			element,
			trackType: trackTypeForMedia(asset),
			placement,
		});
	},

	addText({
		text,
		start,
		duration,
		params = {},
		placement = {},
	}: {
		text: string;
		start: number;
		duration: number;
		params?: Record<string, ParamValue>;
		placement?: Placement;
	}) {
		const element = buildTextElement({
			raw: {
				...DEFAULTS.text.element,
				duration: ticks(duration),
				params: {
					...DEFAULTS.text.element.params,
					...params,
					content: text,
				},
			},
			startTime: ticks(start),
		});
		return insert({ element, trackType: "text", placement });
	},

	/**
	 * Shows the source range [sourceIn, sourceOut) of a clip. Times are in the
	 * clip's own media, not the timeline. Ignores retime (speed changes).
	 */
	trim({
		elementId,
		sourceIn,
		sourceOut,
		start,
	}: {
		elementId: string;
		sourceIn: number;
		sourceOut: number;
		start?: number;
	}) {
		const { element } = findElement({ elementId });
		const sourceDuration =
			secs(element.sourceDuration) ??
			(secs(element.trimStart) ?? 0) +
				(secs(element.duration) ?? 0) +
				(secs(element.trimEnd) ?? 0);
		if (sourceIn < 0 || sourceOut <= sourceIn || sourceOut > sourceDuration) {
			throw new Error(
				`Invalid trim range ${sourceIn}-${sourceOut} for source of ${sourceDuration}s`,
			);
		}
		editor().timeline.updateElementTrim({
			elementId,
			trimStart: ticks(sourceIn),
			trimEnd: ticks(sourceDuration - sourceOut),
			duration: ticks(sourceOut - sourceIn),
			startTime: start !== undefined ? ticks(start) : undefined,
		});
		return describeElement(findElement({ elementId }).element);
	},

	/** Splits at a timeline time; returns the right-hand pieces. */
	split({ elementIds, at }: { elementIds: string[]; at: number }) {
		const elements = elementIds.map((elementId) => ({
			trackId: findElement({ elementId }).track.id,
			elementId,
		}));
		return editor().timeline.splitElements({
			elements,
			splitTime: ticks(at),
		});
	},

	move({
		elementId,
		start,
		trackId,
	}: {
		elementId: string;
		start: number;
		trackId?: string;
	}) {
		const { track } = findElement({ elementId });
		editor().timeline.moveElements({
			moves: [
				{
					sourceTrackId: track.id,
					targetTrackId: trackId ?? track.id,
					elementId,
					newStartTime: ticks(start),
				},
			],
		});
		return describeElement(findElement({ elementId }).element);
	},

	remove({ elementIds }: { elementIds: string[] }) {
		editor().timeline.deleteElements({
			elements: elementIds.map((elementId) => ({
				trackId: findElement({ elementId }).track.id,
				elementId,
			})),
		});
	},

	/** Sets static (non-animated) params, e.g. transform.scaleX, opacity, volume. */
	setParams({
		elementId,
		params,
	}: {
		elementId: string;
		params: Record<string, ParamValue>;
	}) {
		const { track } = findElement({ elementId });
		editor().timeline.updateElements({
			updates: [{ trackId: track.id, elementId, patch: { params } }],
		});
		return describeElement(findElement({ elementId }).element);
	},

	/** Volume in dB, -60..+20. 0 is unchanged. */
	setVolume({ elementId, db }: { elementId: string; db: number }) {
		return agent.setParams({ elementId, params: { volume: db } });
	},

	/**
	 * Adds keyframes on one property. `time` is seconds from the element's
	 * start. Interpolation applies to the segment leaving each keyframe.
	 */
	setKeyframes({
		elementId,
		path,
		keyframes,
	}: {
		elementId: string;
		path: string;
		keyframes: Array<{
			time: number;
			value: ParamValue;
			interpolation?: AnimationInterpolation;
		}>;
	}) {
		const { track } = findElement({ elementId });
		editor().timeline.upsertKeyframes({
			keyframes: keyframes.map(({ time, value, interpolation }) => ({
				trackId: track.id,
				elementId,
				propertyPath: path,
				time: ticks(time),
				value,
				interpolation,
			})),
		});
		return findElement({ elementId }).element.animations?.[path];
	},

	removeTrack({ trackId }: { trackId: string }) {
		editor().timeline.removeTrack({ trackId });
	},

	/**
	 * Moves a track within its group. Overlay index 0 is the top layer; the
	 * main track is fixed and audio tracks only reorder among themselves.
	 */
	reorderTrack({ trackId, toIndex }: { trackId: string; toIndex: number }) {
		const before = editor().scenes.getActiveScene().tracks;
		const group = before.overlay.some((track) => track.id === trackId)
			? "overlay"
			: before.audio.some((track) => track.id === trackId)
				? "audio"
				: null;
		if (!group) {
			throw new Error(`Track ${trackId} is the main track or does not exist`);
		}

		const list: TimelineTrack[] = [...before[group]];
		const fromIndex = list.findIndex((track) => track.id === trackId);
		const [moved] = list.splice(fromIndex, 1);
		list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, moved);

		const after = { ...before, [group]: list } as SceneTracks;
		editor().command.execute({
			command: new TracksSnapshotCommand({ before, after }),
		});
		return agent.getState().tracks;
	},

	undo() {
		editor().command.undo();
	},

	redo() {
		editor().command.redo();
	},

	async save() {
		await editor().project.saveCurrentProject();
	},

	/** Renders the project and keeps the result for readExportChunk(). */
	async export({
		format = "mp4",
		quality = "high",
		includeAudio = true,
	}: {
		format?: "mp4" | "webm";
		quality?: "low" | "medium" | "high" | "very_high";
		includeAudio?: boolean;
	} = {}) {
		lastExport = null;
		const result = await editor().project.export({
			options: { format, quality, includeAudio },
		});
		if (!result.success || !result.buffer) {
			throw new Error(result.error ?? "Export failed");
		}
		lastExport = result.buffer;
		return {
			byteLength: lastExport.byteLength,
			chunkBytes: EXPORT_CHUNK_BYTES,
			chunks: Math.ceil(lastExport.byteLength / EXPORT_CHUNK_BYTES),
		};
	},

	getExportProgress(): number {
		return editor().project.getExportState().progress;
	},

	/** Returns one base64 chunk of the last export. */
	readExportChunk({ index }: { index: number }): string {
		if (!lastExport) {
			throw new Error("No export available; call export() first");
		}
		const bytes = new Uint8Array(
			lastExport,
			index * EXPORT_CHUNK_BYTES,
			Math.min(
				EXPORT_CHUNK_BYTES,
				lastExport.byteLength - index * EXPORT_CHUNK_BYTES,
			),
		);
		let binary = "";
		for (let offset = 0; offset < bytes.length; offset += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
		}
		return btoa(binary);
	},
};

export type OpenCutAgent = typeof agent;

export function installAgentBridge(): void {
	if (typeof window === "undefined") {
		return;
	}

	if (!document.getElementById(AGENT_FILE_INPUT_ID)) {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.id = AGENT_FILE_INPUT_ID;
		input.style.display = "none";
		document.body.appendChild(input);
	}

	(window as Window & { __opencutAgent?: OpenCutAgent }).__opencutAgent =
		agent;
}
