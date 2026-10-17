// Speech-to-text with ffmpeg's whisper.cpp filter, word-level timings,
// deterministic transcript files (.vtt + .words.json), and word search.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { loadConfig, workDir } from "./config.mjs";

const MODEL_URL = (name) =>
	`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;

/** Downloads the whisper.cpp model into <work>/models on first use. */
export async function ensureModel(name = loadConfig().whisper_model) {
	const dir = workDir("models");
	const file = `ggml-${name}.bin`;
	const path = join(dir, file);
	if (existsSync(path)) return { dir, file, path };

	const response = await fetch(MODEL_URL(name));
	if (!response.ok || !response.body) {
		throw new Error(`Model download failed (${response.status}) for ${name}`);
	}
	const partial = `${path}.partial`;
	await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
	await rename(partial, path);
	return { dir, file, path };
}

/**
 * Fingerprint from size + first/last MiB: cheap on large files, stable across
 * moves and renames, and changes when the content changes.
 */
export async function fingerprint(path) {
	const { size } = await stat(path);
	const chunk = Math.min(1 << 20, size);
	const handle = await open(path, "r");
	try {
		const head = Buffer.alloc(chunk);
		const tail = Buffer.alloc(chunk);
		await handle.read(head, 0, chunk, 0);
		await handle.read(tail, 0, chunk, Math.max(0, size - chunk));
		return createHash("sha1")
			.update(String(size))
			.update(head)
			.update(tail)
			.digest("hex")
			.slice(0, 10);
	} finally {
		await handle.close();
	}
}

/** Candidate transcript locations, in lookup order. */
export async function transcriptPaths(videoPath) {
	const absolute = resolve(videoPath);
	const stem = basename(absolute, extname(absolute));
	const besideBase = join(dirname(absolute), stem);
	const workBase = join(workDir("transcripts"), `${stem}.${await fingerprint(absolute)}`);
	const pair = (base) => ({ vtt: `${base}.vtt`, words: `${base}.words.json` });
	return { nextToVideo: pair(besideBase), workFolder: pair(workBase) };
}

export async function findTranscript(videoPath) {
	const paths = await transcriptPaths(videoPath);
	for (const [location, pair] of Object.entries(paths)) {
		if (existsSync(pair.words) || existsSync(pair.vtt)) {
			return {
				location,
				vtt: existsSync(pair.vtt) ? pair.vtt : null,
				words: existsSync(pair.words) ? pair.words : null,
			};
		}
	}
	// Same content under another name (renamed or copied file): match on the
	// fingerprint part of the work-folder name.
	const tag = `.${await fingerprint(resolve(videoPath))}.`;
	const dir = workDir("transcripts");
	const match = (await readdir(dir)).find((name) => name.includes(tag) && name.endsWith(".words.json"));
	if (match) {
		const base = join(dir, match.slice(0, -".words.json".length));
		return {
			location: "workFolder",
			vtt: existsSync(`${base}.vtt`) ? `${base}.vtt` : null,
			words: `${base}.words.json`,
		};
	}
	return null;
}

function runFfmpeg(args, cwd) {
	return new Promise((ok, fail) => {
		const child = spawn("ffmpeg", args, { cwd, windowsHide: true });
		let stderr = "";
		child.stderr.on("data", (data) => (stderr += data));
		child.on("error", fail);
		child.on("close", (code) =>
			code === 0
				? ok(stderr)
				: fail(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1500)}`)),
		);
	});
}

/** Runs whisper and returns raw segments: [{ start, end, text }] in seconds. */
export async function runWhisper(videoPath, { model, language } = {}) {
	const config = loadConfig();
	const { dir, file } = await ensureModel(model ?? config.whisper_model);
	// Filter options can't easily carry Windows drive colons, so run inside
	// the models folder and use relative names.
	const output = `segments-${process.pid}-${Date.now()}.json`;
	const filter = [
		"aresample=16000",
		"aformat=sample_fmts=flt:channel_layouts=mono",
		`whisper=model=${file}:language=${language ?? config.language}:queue=20:max_len=1:format=json:destination=${output}`,
	].join(",");
	try {
		await runFfmpeg(
			["-hide_banner", "-nostats", "-i", resolve(videoPath), "-vn", "-af", filter, "-f", "null", "-"],
			dir,
		);
		return parseWhisperJson(await readFile(join(dir, output), "utf8"));
	} finally {
		await rm(join(dir, output), { force: true });
	}
}

export function parseWhisperJson(raw) {
	// The filter writes one JSON object per line, times in milliseconds.
	return raw
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line))
		.map(({ start, end, text }) => ({ start: start / 1000, end: end / 1000, text }));
}

/** Segments -> [{ start, end, word }]; multi-word segments share time evenly. */
export function segmentsToWords(segments) {
	const words = [];
	for (const { start, end, text } of segments) {
		const parts = text.trim().split(/\s+/).filter(Boolean);
		const step = (end - start) / Math.max(parts.length, 1);
		parts.forEach((word, i) => {
			words.push({
				start: +(start + i * step).toFixed(3),
				end: +(start + (i + 1) * step).toFixed(3),
				word,
			});
		});
	}
	return words;
}

/** Groups words into readable cues, breaking on pauses, punctuation and length. */
export function wordsToCues(words, { maxChars = 42, maxGap = 0.7 } = {}) {
	const cues = [];
	let current = null;
	for (const word of words) {
		const startsNew =
			!current ||
			word.start - current.end > maxGap ||
			current.text.length + 1 + word.word.length > maxChars ||
			/[.!?]$/.test(current.text);
		if (startsNew) {
			current = { start: word.start, end: word.end, text: word.word };
			cues.push(current);
		} else {
			current.end = word.end;
			current.text += ` ${word.word}`;
		}
	}
	return cues;
}

function vttTime(seconds) {
	const ms = Math.round(seconds * 1000);
	const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
	const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
	const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
	return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, "0")}`;
}

export function cuesToVtt(cues) {
	return `WEBVTT\n\n${cues
		.map((cue) => `${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text}`)
		.join("\n\n")}\n`;
}

export function parseVtt(raw) {
	const toSeconds = (stamp) => {
		const parts = stamp.trim().split(":").map(Number);
		return parts.reduce((total, part) => total * 60 + part, 0);
	};
	const cues = [];
	for (const block of raw.replace(/\r/g, "").split(/\n\n+/)) {
		const lines = block.split("\n");
		const timing = lines.findIndex((line) => line.includes("-->"));
		if (timing < 0) continue;
		const [start, end] = lines[timing].split("-->").map((s) => toSeconds(s.split(" ").filter(Boolean)[0] ?? s));
		const text = lines.slice(timing + 1).join(" ").replace(/<[^>]+>/g, "").trim();
		if (text) cues.push({ start, end, text });
	}
	return cues;
}

const FASTER_WHISPER_SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"faster_whisper_transcribe.py",
);

function canUseFasterWhisper(python) {
	if (!python) return Promise.resolve(false);
	return new Promise((ok) => {
		const child = spawn(python, ["-c", "import faster_whisper"], { windowsHide: true });
		child.on("error", () => ok(false));
		child.on("close", (code) => ok(code === 0));
	});
}

/** Picks the engine from settings; "auto" prefers faster-whisper when usable. */
export async function resolveEngine() {
	const { transcription_engine: engine, python } = loadConfig();
	if (engine === "whisper.cpp") return "whisper.cpp";
	const usable = await canUseFasterWhisper(python);
	if (engine === "faster-whisper" && !usable) {
		throw new Error(
			`faster-whisper is selected but "${python || "(no python set)"}" can't import it; set the python setting or install faster-whisper`,
		);
	}
	return usable ? "faster-whisper" : "whisper.cpp";
}

/** Returns [{ start, end, word, prob }] using faster-whisper. */
export function runFasterWhisper(videoPath, { model, language } = {}) {
	const config = loadConfig();
	const args = [
		FASTER_WHISPER_SCRIPT,
		resolve(videoPath),
		model ?? config.whisper_model,
		language ?? config.language,
		workDir("models", "faster-whisper"),
		...(config.keep_fillers ? ["--keep-fillers"] : []),
	];
	return new Promise((ok, fail) => {
		const child = spawn(config.python, args, { windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => (stdout += data));
		child.stderr.on("data", (data) => (stderr += data));
		child.on("error", fail);
		child.on("close", (code) => {
			if (code !== 0) {
				fail(new Error(`faster-whisper exited ${code}: ${stderr.slice(-1500)}`));
				return;
			}
			try {
				ok(JSON.parse(stdout).words);
			} catch (error) {
				fail(new Error(`Unreadable faster-whisper output: ${error.message}`));
			}
		});
	});
}

/**
 * Transcribes a video (or reuses an existing transcript) and returns where the
 * files are. Existing transcripts are reused unless `force` is set.
 */
export async function transcribe(videoPath, { force = false, location, model, language } = {}) {
	const absolute = resolve(videoPath);
	if (!existsSync(absolute)) throw new Error(`File not found: ${absolute}`);
	if (!force) {
		const existing = await findTranscript(absolute);
		if (existing) return { ...existing, reused: true };
	}

	const paths = await transcriptPaths(absolute);
	const target =
		(location ?? loadConfig().transcript_location) === "next_to_video"
			? { location: "nextToVideo", ...paths.nextToVideo }
			: { location: "workFolder", ...paths.workFolder };

	const engine = await resolveEngine();
	const started = Date.now();
	const words =
		engine === "faster-whisper"
			? await runFasterWhisper(absolute, { model, language })
			: segmentsToWords(await runWhisper(absolute, { model, language }));
	const cues = wordsToCues(words);
	await writeFile(
		target.words,
		JSON.stringify({
			source: absolute,
			engine,
			model: model ?? loadConfig().whisper_model,
			created: new Date().toISOString(),
			words,
		}),
	);
	await writeFile(target.vtt, cuesToVtt(cues));
	return {
		location: target.location,
		vtt: target.vtt,
		words: target.words,
		reused: false,
		engine,
		seconds: +((Date.now() - started) / 1000).toFixed(1),
		word_count: words.length,
		cue_count: cues.length,
	};
}

const normalize = (text) =>
	text
		.toLowerCase()
		.replace(/[’']/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

/** Loads word timings, or approximates them from VTT cues when only a .vtt exists. */
export async function loadWords(transcript) {
	if (transcript.words) {
		return { precision: "word", words: JSON.parse(await readFile(transcript.words, "utf8")).words };
	}
	const cues = parseVtt(await readFile(transcript.vtt, "utf8"));
	return { precision: "cue", words: segmentsToWords(cues), cues };
}

/**
 * Finds every occurrence of each phrase. Matching ignores case and
 * punctuation. Returns timeline-ready start/end seconds plus context.
 */
export async function findWords(videoPath, phrases, { context = 6, transcribeIfMissing = true } = {}) {
	let transcript = await findTranscript(videoPath);
	let transcribed = false;
	if (!transcript) {
		if (!transcribeIfMissing) throw new Error("No transcript found");
		transcript = await transcribe(videoPath);
		transcribed = true;
	}
	const { precision, words } = await loadWords(transcript);
	const tokens = words.map((w) => normalize(w.word));

	const results = phrases.map((phrase) => {
		const target = normalize(phrase).split(" ").filter(Boolean);
		const matches = [];
		if (target.length === 0) return { phrase, matches };
		for (let i = 0; i + target.length <= tokens.length; i++) {
			if (target.every((part, k) => tokens[i + k] === part)) {
				const last = i + target.length - 1;
				matches.push({
					start: words[i].start,
					end: words[last].end,
					context: words
						.slice(Math.max(0, i - context), last + context + 1)
						.map((w) => w.word)
						.join(" "),
				});
			}
		}
		return { phrase, count: matches.length, matches };
	});

	return {
		transcript: transcript.vtt ?? transcript.words,
		precision,
		transcribed,
		results,
	};
}
