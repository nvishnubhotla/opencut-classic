// Registry of published results (exports, transcripts, previews...). Stored
// as JSON in the work folder so the MCP server and a standalone serve.mjs
// share it; the web server watches the file for changes.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { loadConfig, workPath } from "./config.mjs";

const KINDS = {
	".mp4": "video",
	".webm": "video",
	".mov": "video",
	".mkv": "video",
	".mp3": "audio",
	".wav": "audio",
	".m4a": "audio",
	".aac": "audio",
	".png": "image",
	".jpg": "image",
	".jpeg": "image",
	".gif": "image",
	".webp": "image",
	".vtt": "subtitles",
	".json": "data",
	".txt": "text",
	".html": "page",
};

export function registryPath() {
	return workPath("published.json");
}

export function sessionPath() {
	return workPath("session.json");
}

export function listArtifacts() {
	const path = registryPath();
	if (!existsSync(path)) return [];
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
}

export function artifactUrl(artifact, { port = loadConfig().server_port } = {}) {
	return `http://localhost:${port}/a/${artifact.id}/${encodeURIComponent(basename(artifact.path))}`;
}

/**
 * Adds (or refreshes) a file in the registry. Republishing the same path keeps
 * its id so URLs stay stable when a file is regenerated.
 */
export function publishArtifact(path, { title, kind, meta } = {}) {
	const absolute = resolve(path);
	if (!existsSync(absolute)) throw new Error(`File not found: ${absolute}`);
	const artifacts = listArtifacts();
	const existing = artifacts.find((a) => a.path === absolute);
	const artifact = {
		id: existing?.id ?? randomUUID().slice(0, 8),
		path: absolute,
		title: title ?? existing?.title ?? basename(absolute),
		kind: kind ?? KINDS[extname(absolute).toLowerCase()] ?? "file",
		meta: meta ?? existing?.meta,
		updated: new Date().toISOString(),
	};
	const next = [artifact, ...artifacts.filter((a) => a.path !== absolute)];
	writeFileSync(registryPath(), JSON.stringify(next, null, 1));
	return { ...artifact, url: artifactUrl(artifact) };
}

export function unpublishArtifact(id) {
	const artifacts = listArtifacts();
	writeFileSync(registryPath(), JSON.stringify(artifacts.filter((a) => a.id !== id), null, 1));
}

/** Records what the editor is showing, for /api/status and /editor. */
export function writeSession(session) {
	writeFileSync(sessionPath(), JSON.stringify({ ...session, updated: new Date().toISOString() }));
}

export function readSession() {
	try {
		return JSON.parse(readFileSync(sessionPath(), "utf8"));
	} catch {
		return null;
	}
}
