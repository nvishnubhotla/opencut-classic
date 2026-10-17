// Generates a spoken test clip (Windows speech synthesis) with known words and
// pauses, muxed over a test pattern: agent/out/media/speech.mp4
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../out/media");
mkdirSync(out, { recursive: true });
const wav = resolve(out, "speech-raw.wav");

const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = 0
$s.SetOutputToWaveFile('${wav}')
$p = New-Object System.Speech.Synthesis.PromptBuilder
$p.AppendText('Welcome to the channel. Today we are building a video editor.')
$p.AppendBreak([TimeSpan]::FromSeconds(2))
$p.AppendText('First, we cut out the silent parts.')
$p.AppendBreak([TimeSpan]::FromSeconds(1.5))
$p.AppendText('Then we zoom in on the important details, and add a sound effect.')
$p.AppendBreak([TimeSpan]::FromSeconds(1))
$p.AppendText('Thanks for watching, and see you next time.')
$s.Speak($p)
$s.Dispose()
`;
execFileSync("powershell", ["-NoProfile", "-Command", script], { stdio: "inherit" });

execFileSync(
	"ffmpeg",
	[
		"-v", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30",
		"-i", wav,
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
		resolve(out, "speech.mp4"),
	],
	{ stdio: "inherit" },
);
rmSync(wav);
console.log("wrote", resolve(out, "speech.mp4"));
