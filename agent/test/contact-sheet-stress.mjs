// Two concurrent contact_sheet calls on large vertical 4K video, as reported
// in a crash. Checks the server survives, answers both, and stays usable.
// Usage: node test/contact-sheet-stress.mjs [video ...]
import { resolve } from "node:path";
import { agentDir, connect } from "./mcp-client.mjs";

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
	const clip = resolve(agentDir, "out/media/vertical-4k-hevc.mov");
	inputs.push(clip, clip);
}

const check = (condition, label) => {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
	if (!condition) process.exitCode = 1;
};

const mcp = await connect();
try {
	const started = Date.now();
	const replies = await Promise.all(
		inputs.map((path) =>
			mcp.request("tools/call", { name: "contact_sheet", arguments: { path, frames: 36 } }),
		),
	);
	console.log(`both answered in ${((Date.now() - started) / 1000).toFixed(1)}s`);
	for (const [index, reply] of replies.entries()) {
		const image = reply.result?.content?.find((c) => c.type === "image");
		const bytes = image ? Buffer.from(image.data, "base64").length : 0;
		console.log(`  #${index}: ${reply.error?.message ?? reply.result?.content?.[0]?.text?.slice(0, 120)}`);
		console.log(`  #${index}: image ${(bytes / 1e6).toFixed(2)} MB, response line ${(JSON.stringify(reply).length / 1e6).toFixed(2)} MB`);
		check(Boolean(image) && !reply.result.isError, `call ${index} returned an image`);
	}
	const ping = await mcp.request("ping", {});
	check(ping.result !== undefined, "server still answers afterwards");
} catch (error) {
	console.error("\nFAILED:", error.message);
	process.exitCode = 1;
} finally {
	mcp.close();
}
