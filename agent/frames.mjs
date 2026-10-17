// Grabs still frames from a video using the browser's decoder (no ffmpeg).
// Usage: node frames.mjs <video> <seconds...>   -> out/frames/<name>-<t>.png
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const [videoPath, ...times] = process.argv.slice(2);
if (!videoPath || times.length === 0) {
	console.error("Usage: node frames.mjs <video> <seconds...>");
	process.exit(1);
}

const executablePath = [
	process.env.OPENCUT_BROWSER,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((path) => path && existsSync(path));

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
const bytes = await readFile(videoPath);
// A blob URL (unlike an intercepted request) supports the range reads seeking needs.
const frames = await page.evaluate(async ({ seconds, base64 }) => {
	const binary = atob(base64);
	const data = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
	const video = document.createElement("video");
	video.muted = true;
	video.src = URL.createObjectURL(new Blob([data], { type: "video/mp4" }));
	await new Promise((ok, fail) => {
		video.onloadeddata = ok;
		video.onerror = () => fail(new Error("Video failed to load"));
	});
	const canvas = document.createElement("canvas");
	canvas.width = 960;
	canvas.height = Math.round((960 * video.videoHeight) / video.videoWidth);
	const context = canvas.getContext("2d");
	const out = [];
	for (const time of seconds) {
		await new Promise((ok) => {
			video.onseeked = ok;
			video.currentTime = time;
		});
		// "seeked" can fire before the frame is presentable; give the decoder a beat.
		await new Promise((ok) => setTimeout(ok, 250));
		context.drawImage(video, 0, 0, canvas.width, canvas.height);
		out.push({ time, data: canvas.toDataURL("image/png") });
	}
	return { duration: video.duration, out };
}, { seconds: times.map(Number), base64: bytes.toString("base64") });

await mkdir("out/frames", { recursive: true });
const name = basename(videoPath).replace(/\.\w+$/, "");
console.log(`${videoPath}: ${frames.duration.toFixed(2)}s`);
for (const { time, data } of frames.out) {
	const file = resolve(`out/frames/${name}-${time}.png`);
	await writeFile(file, Buffer.from(data.split(",")[1], "base64"));
	console.log(file);
}
await browser.close();
