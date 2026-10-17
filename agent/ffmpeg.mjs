// ffmpeg/ffprobe helpers for work that happens outside the editor.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

function run(command, args) {
	return new Promise((ok, fail) => {
		const child = spawn(command, args, { windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => (stdout += data));
		child.stderr.on("data", (data) => (stderr += data));
		child.on("error", (error) =>
			fail(
				error.code === "ENOENT"
					? new Error(`${command} not found on PATH`)
					: error,
			),
		);
		child.on("close", (code) =>
			code === 0
				? ok({ stdout, stderr })
				: fail(new Error(`${command} exited ${code}: ${stderr.slice(-1500)}`)),
		);
	});
}

export async function probe(path) {
	const { stdout } = await run("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration:stream=codec_type,codec_name,width,height,pix_fmt",
		"-of",
		"json",
		path,
	]);
	const info = JSON.parse(stdout);
	return {
		duration: Number(info.format?.duration ?? 0),
		hasVideo: info.streams.some((s) => s.codec_type === "video"),
		hasAudio: info.streams.some((s) => s.codec_type === "audio"),
		streams: info.streams,
	};
}

function sibling(path, suffix, extension) {
	const ext = extension ?? extname(path);
	return join(dirname(path), `${basename(path, extname(path))}${suffix}${ext}`);
}

/**
 * The editor draws images as single stills, so animated GIFs are converted to
 * video first. WebM/VP9 keeps an alpha channel; whether it survives depends on
 * the browser's decoder.
 */
export async function convertGif(input, { keepAlpha = true, minDuration, outputDir } = {}) {
	// Loop the GIF enough times to cover minDuration, since clips longer than
	// their source freeze on the last frame.
	const { duration } = await probe(input);
	const loops =
		minDuration && duration > 0 ? Math.max(0, Math.ceil(minDuration / duration) - 1) : 0;
	const besideInput = sibling(input, loops ? `.gif.x${loops + 1}` : ".gif", keepAlpha ? ".webm" : ".mp4");
	const output = outputDir ? join(outputDir, basename(besideInput)) : besideInput;
	const args = keepAlpha
		? ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30", "-auto-alt-ref", "0"]
		: ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"];
	await run("ffmpeg", [
		"-v", "error", "-y",
		...(loops ? ["-stream_loop", String(loops)] : []),
		"-i", input, "-an", ...args, output,
	]);
	return output;
}

export async function detectSilences(
	input,
	{ thresholdDb = -35, minSilence = 0.5 } = {},
) {
	const { stderr } = await run("ffmpeg", [
		"-hide_banner",
		"-i",
		input,
		"-af",
		`silencedetect=noise=${thresholdDb}dB:d=${minSilence}`,
		"-f",
		"null",
		"-",
	]);
	const silences = [];
	let start = null;
	for (const line of stderr.split(/\r?\n/)) {
		const startMatch = line.match(/silence_start: (-?[\d.]+)/);
		const endMatch = line.match(/silence_end: ([\d.]+)/);
		if (startMatch) start = Math.max(0, Number(startMatch[1]));
		if (endMatch && start !== null) {
			silences.push({ start, end: Number(endMatch[1]) });
			start = null;
		}
	}
	return { silences, openSilenceStart: start };
}

/**
 * Removes silent stretches. `padding` seconds of each silence are kept next to
 * speech so cuts don't clip words.
 */
export async function cutSilences(
	input,
	{
		output,
		thresholdDb = -35,
		minSilence = 0.5,
		padding = 0.15,
		dryRun = false,
	} = {},
) {
	input = resolve(input);
	output = resolve(output ?? sibling(input, ".nosilence"));
	const info = await probe(input);
	if (!info.hasAudio) {
		throw new Error("Input has no audio track to detect silence in");
	}
	const { silences, openSilenceStart } = await detectSilences(input, {
		thresholdDb,
		minSilence,
	});
	if (openSilenceStart !== null) {
		silences.push({ start: openSilenceStart, end: info.duration });
	}

	const removed = silences
		.map(({ start, end }) => ({
			start: start === 0 ? 0 : start + padding,
			end: end >= info.duration - 0.01 ? info.duration : end - padding,
		}))
		.filter(({ start, end }) => end - start > 0.05);

	const keep = [];
	let cursor = 0;
	for (const { start, end } of removed) {
		if (start > cursor) keep.push({ start: cursor, end: start });
		cursor = end;
	}
	if (cursor < info.duration) keep.push({ start: cursor, end: info.duration });

	const removedSeconds = removed.reduce((sum, r) => sum + r.end - r.start, 0);
	const summary = {
		input,
		output: dryRun ? null : output,
		originalDuration: info.duration,
		newDuration: info.duration - removedSeconds,
		removedSeconds,
		cuts: removed.map(({ start, end }) => ({
			start: +start.toFixed(3),
			end: +end.toFixed(3),
		})),
	};
	if (dryRun || removed.length === 0) {
		return { ...summary, output: removed.length === 0 ? null : summary.output };
	}

	const parts = [];
	const labels = [];
	keep.forEach(({ start, end }, i) => {
		const range = `start=${start.toFixed(4)}:end=${end.toFixed(4)}`;
		if (info.hasVideo) {
			parts.push(`[0:v]trim=${range},setpts=PTS-STARTPTS[v${i}]`);
			labels.push(`[v${i}]`);
		}
		parts.push(`[0:a]atrim=${range},asetpts=PTS-STARTPTS[a${i}]`);
		labels.push(`[a${i}]`);
	});
	parts.push(
		`${labels.join("")}concat=n=${keep.length}:v=${info.hasVideo ? 1 : 0}:a=1${info.hasVideo ? "[v]" : ""}[a]`,
	);

	// Long filter graphs overflow the command line, so pass them as a file.
	const scriptPath = join(tmpdir(), `opencut-cut-${randomUUID()}.txt`);
	await writeFile(scriptPath, parts.join(";\n"));
	try {
		await mkdir(dirname(output), { recursive: true });
		await run("ffmpeg", [
			"-v",
			"error",
			"-y",
			"-i",
			input,
			"-/filter_complex",
			scriptPath,
			...(info.hasVideo
				? ["-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]
				: []),
			"-map",
			"[a]",
			"-c:a",
			"aac",
			"-b:a",
			"192k",
			output,
		]);
	} finally {
		await rm(scriptPath, { force: true });
	}
	return summary;
}

/** Tiles evenly spaced frames into one PNG; returns base64. */
export async function contactSheet(input, { frames = 12, columns = 4, width = 480 } = {}) {
	const { duration, hasVideo } = await probe(input);
	if (!hasVideo) throw new Error("No video stream");
	const count = Math.max(1, Math.min(frames, 36));
	const rows = Math.ceil(count / columns);
	const output = join(tmpdir(), `opencut-sheet-${randomUUID()}.png`);
	try {
		await run("ffmpeg", [
			"-v",
			"error",
			"-y",
			"-i",
			input,
			"-vf",
			`fps=${count / duration},scale=${width}:-2,tile=${columns}x${rows}:padding=4:color=red`,
			"-frames:v",
			"1",
			output,
		]);
		const times = Array.from({ length: count }, (_, i) =>
			+((i * duration) / count).toFixed(2),
		);
		return { png: (await readFile(output)).toString("base64"), times, duration };
	} finally {
		await rm(output, { force: true });
	}
}
