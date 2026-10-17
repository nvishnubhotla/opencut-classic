// Persistent settings for the agent tools, shared across sessions.
// Stored per user so every checkout and session sees the same work folder.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CONFIG_PATH =
	process.env.OPENCUT_AGENT_CONFIG ??
	join(process.env.APPDATA ?? join(homedir(), ".config"), "opencut-agent", "config.json");

const DEFAULTS = {
	// Flat folder for generated files: transcripts, converted media, exports.
	work_folder: join(homedir(), "opencut-work"),
	// Where new transcripts are written: "work_folder" or "next_to_video".
	transcript_location: "work_folder",
	// "auto" uses faster-whisper when `python` can import it, else whisper.cpp.
	transcription_engine: "auto",
	// Python interpreter with faster-whisper installed (e.g. a venv's python.exe).
	python: "",
	// Model name. whisper.cpp: tiny(.en)/base(.en)/small(.en)/medium(.en)/
	// large-v3-turbo. faster-whisper: same names, plus large-v3.
	whisper_model: "base.en",
	// Keep filler words (um, uh, like) that Whisper normally drops.
	keep_fillers: false,
	// Spoken language, or "auto".
	language: "en",
	// Port for the media server; 0 disables auto-start.
	server_port: 8787,
};

export const SETTING_DESCRIPTIONS = {
	work_folder: "Flat folder for generated files (transcripts, converted media, exports, previews)",
	transcript_location: '"work_folder" or "next_to_video" for newly generated transcripts',
	transcription_engine: '"auto", "faster-whisper" or "whisper.cpp"',
	python: "Path to a Python with faster-whisper installed (enables that engine)",
	whisper_model: "tiny(.en), base(.en), small(.en), medium(.en), large-v3-turbo; bigger = more accurate, slower",
	keep_fillers: "Keep um/uh/like in transcripts (faster-whisper only)",
	language: 'Spoken language code (e.g. "en") or "auto"',
	server_port: "Media server port; 0 = don't start it automatically",
};

export function configPath() {
	return CONFIG_PATH;
}

export function loadConfig() {
	let stored = {};
	if (existsSync(CONFIG_PATH)) {
		try {
			stored = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		} catch {
			stored = {};
		}
	}
	return { ...DEFAULTS, ...stored };
}

export function saveConfig(patch) {
	const next = { ...loadConfig() };
	for (const [key, value] of Object.entries(patch)) {
		if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
		if (value === undefined) continue;
		next[key] = key === "work_folder" ? resolve(value) : value;
	}
	if (!["work_folder", "next_to_video"].includes(next.transcript_location)) {
		throw new Error('transcript_location must be "work_folder" or "next_to_video"');
	}
	if (!["auto", "faster-whisper", "whisper.cpp"].includes(next.transcription_engine)) {
		throw new Error('transcription_engine must be "auto", "faster-whisper" or "whisper.cpp"');
	}
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

/** Returns a subfolder of the work folder, creating it if needed. */
export function workPath(...parts) {
	const path = join(loadConfig().work_folder, ...parts);
	mkdirSync(dirname(path), { recursive: true });
	return path;
}

export function workDir(...parts) {
	const path = join(loadConfig().work_folder, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
}
