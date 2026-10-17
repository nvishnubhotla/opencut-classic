// End-to-end check of the bridge: text + zoom keyframes -> export, then
// re-import that export as footage -> trim, overlays, reorder, volume -> export.
import { launch } from "./opencut.mjs";

const headless = !process.argv.includes("--headed");
const step = (label) => console.log(`\n== ${label}`);

const editor = await launch({ headless });
try {
	step("project");
	const initial = await editor.getState();
	console.log(initial.projectId, initial.fps, initial.canvasSize);

	step("text with zoom in / hold / zoom out");
	const title = await editor.addText({
		text: "Hello OpenCut",
		start: 0,
		duration: 4,
		params: { fontSize: 20 },
	});
	for (const path of ["transform.scaleX", "transform.scaleY"]) {
		await editor.setKeyframes({
			elementId: title.elementId,
			path,
			keyframes: [
				{ time: 0, value: 1, interpolation: "bezier" },
				{ time: 1, value: 1.8, interpolation: "hold" },
				{ time: 3, value: 1.8, interpolation: "bezier" },
				{ time: 4, value: 1 },
			],
		});
	}
	console.log(await editor.getElement({ elementId: title.elementId }));

	step("export stage 1");
	console.log(await editor.exportTo("out/stage1.mp4"));

	step("import stage 1 back as footage");
	const [clip] = await editor.importFiles(["out/stage1.mp4"]);
	console.log(clip);

	const placed = await editor.addMedia({
		mediaId: clip.id,
		start: 5,
		placement: { newTrack: true },
	});
	console.log("placed", placed);

	step("trim to source 1s..3s");
	console.log(
		await editor.trim({ elementId: placed.elementId, sourceIn: 1, sourceOut: 3 }),
	);

	step("volume -6 dB");
	console.log((await editor.setVolume({ elementId: placed.elementId, db: -6 })).params);

	step("two overlay text tracks, then reorder");
	const top = await editor.addText({
		text: "TOP",
		start: 5,
		duration: 2,
		placement: { newTrack: true, trackIndex: 0 },
	});
	const bottom = await editor.addText({
		text: "BOTTOM",
		start: 5,
		duration: 2,
		placement: { newTrack: true, trackIndex: 1 },
	});
	await editor.setParams({
		elementId: bottom.elementId,
		params: { "transform.positionY": 120 },
	});
	const order = (tracks) =>
		tracks.map((t) => `${t.index}:${t.type}:${t.elements.map((e) => e.params.content ?? e.name).join(",")}`);
	console.log("before", order((await editor.getState()).tracks));
	console.log("after ", order(await editor.reorderTrack({ trackId: bottom.trackId, toIndex: 0 })));

	step("export stage 2");
	console.log(await editor.exportTo("out/stage2.mp4"));

	await editor.save();
	await editor.page.screenshot({ path: "out/editor.png" });
} catch (error) {
	console.error("\nFAILED:", error.message);
	await editor.page.screenshot({ path: "out/failure.png" }).catch(() => {});
	process.exitCode = 1;
} finally {
	if (editor.logs.length) {
		console.log("\n== browser errors/warnings");
		console.log(editor.logs.slice(-25).join("\n"));
	}
	await editor.close();
}
