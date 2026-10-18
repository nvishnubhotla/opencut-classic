// Transcription, word search and media server, through the MCP server.
// Uses a throwaway settings file so the user's settings are untouched.
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.mjs";
import { agentDir, connect } from "./mcp-client.mjs";

const media = resolve(agentDir, "out/media");
const speech = resolve(media, "speech.mp4");
const renamed = resolve(media, "speech-renamed.mp4");
const configFile = resolve(agentDir, "out/test-config.json");
rmSync(configFile, { force: true });

const check = (condition, label) => {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
	if (!condition) process.exitCode = 1;
};

const mcp = await connect({ env: { OPENCUT_AGENT_CONFIG: configFile } });
try {
	const { settings } = await mcp.tool("get_settings");
	// Reuse the real python setting so faster-whisper is exercised when installed.
	const { python } = loadConfig();
	await mcp.tool("set_settings", { transcript_location: "work_folder", server_port: 8799, python });

	const first = await mcp.tool("transcribe_video", { path: speech, force: true });
	check(existsSync(first.vtt) && existsSync(first.words), "vtt + words.json written");
	check(first.vtt.startsWith(settings.work_folder), "written in the work folder");
	if (python) check(first.engine === "faster-whisper", "faster-whisper engine used");

	const second = await mcp.tool("transcribe_video", { path: speech });
	check(second.reused === true && second.vtt === first.vtt, "second call reuses transcript");

	copyFileSync(speech, renamed);
	const moved = await mcp.tool("transcribe_video", { path: renamed });
	check(moved.reused === true, "renamed copy finds the same transcript (content fingerprint)");
	rmSync(renamed);

	const found = await mcp.tool("find_words", {
		path: speech,
		phrases: ["video editor", "sound effect", "thanks for watching", "zoom", "not in the clip"],
	});
	const byPhrase = Object.fromEntries(found.results.map((r) => [r.phrase, r]));
	check(byPhrase["video editor"].count === 1, '"video editor" found once');
	check(byPhrase["not in the clip"].count === 0, "absent phrase not found");

	const slice = await mcp.tool("get_transcript", { path: speech, start: 5, end: 12 });
	check(slice.cues.length > 0 && slice.cues.every((c) => c.end > 5 && c.start < 12), "range filter");

	const server = await mcp.tool("media_server");
	const artifacts = await (await fetch(server.artifacts_api)).json();
	const vtt = artifacts.find((a) => a.path === first.vtt);
	check(Boolean(vtt), "transcript published");
	const ranged = await fetch(vtt.url, { headers: { Range: "bytes=0-5" } });
	check(ranged.status === 206 && (await ranged.text()) === "WEBVTT", "byte-range request served");
	const gallery = await fetch(server.gallery);
	check(gallery.ok && (await gallery.text()).includes("OpenCut results"), "gallery page");

	// Live updates: publishing a file should push an event to /events.
	const events = await fetch(server.events_sse);
	const reader = events.body.getReader();
	await reader.read(); // ": connected"
	const nextEvent = Promise.race([
		reader.read().then(() => true),
		new Promise((ok) => setTimeout(() => ok(false), 3000)),
	]);
	await mcp.tool("publish_file", { path: resolve(media, "beep.wav"), title: "beep" });
	check(await nextEvent, "SSE event after publish");
	reader.cancel();
} catch (error) {
	console.error("\nFAILED:", error.message);
	process.exitCode = 1;
} finally {
	mcp.close();
}
