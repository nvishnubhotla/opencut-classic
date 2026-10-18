// Creates agent/.venv with faster-whisper and points the `python` setting at it.
// Usage: node setup-whisper.mjs [--python <base interpreter>] [--model small.en]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveConfig } from "./config.mjs";

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const VENV = resolve(AGENT_DIR, ".venv");
const VENV_PYTHON = resolve(VENV, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

const argValue = (flag) => {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
};

function run(command, args, { quiet = false } = {}) {
	const result = spawnSync(command, args, {
		stdio: quiet ? "pipe" : "inherit",
		encoding: "utf8",
		windowsHide: true,
	});
	return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

/** Finds a Python 3.9+ to build the venv from. */
function findBasePython() {
	const explicit = argValue("--python");
	const candidates = explicit
		? [[explicit, []]]
		: [["py", ["-3"]], ["python", []], ["python3", []]];
	for (const [command, prefix] of candidates) {
		const probe = run(
			command,
			[...prefix, "-c", "import sys; print(sys.version_info >= (3, 9))"],
			{ quiet: true },
		);
		if (probe.ok && probe.stdout.trim() === "True") return [command, prefix];
	}
	throw new Error(
		"No Python 3.9+ found (tried py -3, python, python3). Install Python or pass --python <path>.",
	);
}

if (!existsSync(VENV_PYTHON)) {
	const [command, prefix] = findBasePython();
	console.log(`Creating ${VENV} with ${[command, ...prefix].join(" ")}`);
	if (!run(command, [...prefix, "-m", "venv", VENV]).ok) throw new Error("venv creation failed");
}

console.log("Installing faster-whisper");
if (!run(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", "pip", "faster-whisper"]).ok) {
	throw new Error("pip install failed");
}
if (!run(VENV_PYTHON, ["-c", "import faster_whisper"], { quiet: true }).ok) {
	throw new Error("faster-whisper installed but can't be imported");
}

const model = argValue("--model");
const settings = saveConfig({
	python: VENV_PYTHON,
	transcription_engine: "faster-whisper",
	...(model ? { whisper_model: model } : {}),
});
console.log(
	`Done. python=${settings.python} engine=${settings.transcription_engine} model=${settings.whisper_model}`,
);
