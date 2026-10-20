// Times ffmpeg's whisper.cpp filter with and without GPU on a looped clip.
// Usage: node test/bench-whisper.mjs [model=base.en] [loops=7]
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ensureModel } from "../transcribe.mjs";
import { agentDir } from "./mcp-client.mjs";

const [model = "base.en", loops = "7"] = process.argv.slice(2);
const input = resolve(agentDir, "out/media/speech.mp4");
const { dir: modelsDir, file: modelFile } = await ensureModel(model);

for (const gpu of [0, 1]) {
	const started = Date.now();
	const run = spawnSync(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel", "info",
			"-stream_loop", loops,
			"-i", input,
			"-vn",
			"-af",
			`aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono,whisper=model=${modelFile}:language=en:queue=20:use_gpu=${gpu}`,
			"-f", "null", "-",
		],
		{ cwd: modelsDir, encoding: "utf8", windowsHide: true },
	);
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	const backend = run.stderr
		.split("\n")
		.filter((line) => /vulkan|gpu|backend|ggml_/i.test(line))
		.slice(0, 4)
		.join("\n  ");
	console.log(`use_gpu=${gpu}: ${seconds}s (exit ${run.status})${backend ? `\n  ${backend}` : ""}`);
}
