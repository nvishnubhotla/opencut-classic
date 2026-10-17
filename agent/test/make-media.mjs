// Generates synthetic test media into agent/out/media with ffmpeg.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../out/media");
mkdirSync(out, { recursive: true });
const ffmpeg = (args) =>
	execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });

// "Talking" clip: tone with silent gaps at 2-4s and 6-7.5s.
ffmpeg([
	"-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=9",
	"-f", "lavfi", "-i",
	"aevalsrc=0.4*sin(2*PI*440*t)*(between(t\\,0\\,2)+between(t\\,4\\,6)+between(t\\,7.5\\,9)):s=48000:d=9",
	"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
	`${out}/talk.mp4`,
]);

// Sound effect.
ffmpeg(["-f", "lavfi", "-i", "sine=f=1200:d=0.3", `${out}/beep.wav`]);

// GIF with a transparent background and a moving red ball.
ffmpeg([
	"-f", "lavfi", "-i",
	"color=c=red:s=160x160:d=2:r=15,format=rgba,geq=r=255:g=40:b=40:a='if(lt(hypot(X-80-40*sin(2*PI*T)\\,Y-80)\\,35)\\,255\\,0)'",
	"-vf", "split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128",
	"-loop", "0",
	`${out}/ball.gif`,
]);

console.log("media written to", out);
