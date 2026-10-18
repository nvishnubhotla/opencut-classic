import { EditorCore } from "@/core";
import { BatchCommand } from "@/commands";
import { AddTrackCommand, InsertElementCommand } from "@/commands/timeline";
import { processMediaAssets } from "@/media/processing";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { mediaTimeFromSeconds } from "@/wasm";
import type { GiphyResult } from "./types";

function fileName({ gif }: { gif: GiphyResult }): string {
	const slug = gif.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	return `${slug || "giphy"}-${gif.id}.mp4`;
}

/**
 * Imports a GIPHY result (as its MP4 rendition, since the editor plays video
 * rather than GIF) and places it at the playhead on a new top track.
 */
export async function addGifToTimeline({
	gif,
}: {
	gif: GiphyResult;
}): Promise<void> {
	const editor = EditorCore.getInstance();
	const response = await fetch(
		`/api/giphy/media?url=${encodeURIComponent(gif.mp4Url)}`,
	);
	if (!response.ok) {
		throw new Error(`Download failed (${response.status})`);
	}
	const blob = await response.blob();
	const file = new File([blob], fileName({ gif }), {
		type: "video/mp4",
		lastModified: Date.now(),
	});

	const projectId = editor.project.getActive().metadata.id;
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) {
		throw new Error("Could not read the GIF video");
	}
	const asset = await editor.media.addMediaAsset({ projectId, asset: processed });
	if (!asset) {
		throw new Error("Could not save the GIF to this project");
	}

	const element = buildElementFromMedia({
		mediaId: asset.id,
		mediaType: asset.type,
		name: asset.name,
		duration:
			asset.duration != null
				? mediaTimeFromSeconds({ seconds: asset.duration })
				: DEFAULT_NEW_ELEMENT_DURATION,
		startTime: editor.playback.getCurrentTime(),
	});
	// Empty tracks are pruned after every command, so create the track and
	// its element together.
	const addTrack = new AddTrackCommand({ type: "video", index: 0 });
	const insert = new InsertElementCommand({
		element,
		placement: { mode: "explicit", trackId: addTrack.getTrackId() },
	});
	editor.command.execute({ command: new BatchCommand([addTrack, insert]) });
}
