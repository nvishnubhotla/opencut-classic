// GIPHY tab: opens the editor, searches, clicks a result and checks that it
// landed on a new top track. Needs GIPHY_API_KEY in apps/web/.env.local.
import { resolve } from "node:path";
import { launch } from "../opencut.mjs";
import { agentDir } from "./mcp-client.mjs";

const check = (condition, label) => {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
	if (!condition) process.exitCode = 1;
};

const editor = await launch({ userDataDir: resolve(agentDir, "out/giphy-profile") });
const { page } = editor;
try {
	// A fresh profile greets with a modal welcome dialog.
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "GIFs", exact: true }).first().click();
	const search = page.getByPlaceholder("Search GIPHY...");
	await search.waitFor();
	check(true, "GIFs tab opens");
	await page.screenshot({ path: resolve(agentDir, "out/giphy-tab.png") });

	const probe = await page.evaluate(async () => {
		const res = await fetch("/api/giphy/search?q=cat&limit=1");
		return { status: res.status, body: await res.json() };
	});
	if (probe.status === 503) {
		console.log(`SKIP  search: ${probe.body.error}`);
	} else {
		await search.fill("thumbs up");
		const first = page.locator("button[title^='Add']").first();
		await first.waitFor({ timeout: 15_000 });
		await page.screenshot({ path: resolve(agentDir, "out/giphy-results.png") });
		check(true, "search shows results");

		const before = (await editor.getState()).tracks.length;
		await first.click();
		await page.waitForFunction(
			(count) => window.__opencutAgent.getState().tracks.length > count,
			before,
			{ timeout: 60_000 },
		);
		const state = await editor.getState();
		const top = state.tracks[0];
		check(top.type === "video" && top.elements.length === 1, "GIF placed on a new top track");
		check(state.media.some((m) => m.type === "video" && m.name.endsWith(".mp4")), "imported as video");
		const frame = await editor.renderFrame({ time: top.elements[0].start + 0.2, width: 640 });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(resolve(agentDir, "out/giphy-frame.jpg"), Buffer.from(frame, "base64"));
	}
} catch (error) {
	console.error("\nFAILED:", error.message);
	process.exitCode = 1;
} finally {
	await editor.close();
}
