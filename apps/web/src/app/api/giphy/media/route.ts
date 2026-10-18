import { type NextRequest, NextResponse } from "next/server";

/** Proxies a GIPHY media file so the editor can import it same-origin. */
export async function GET(request: NextRequest) {
	const raw = request.nextUrl.searchParams.get("url");
	let url: URL;
	try {
		url = new URL(raw ?? "");
	} catch {
		return NextResponse.json({ error: "Invalid url" }, { status: 400 });
	}
	if (url.protocol !== "https:" || !url.hostname.endsWith(".giphy.com")) {
		return NextResponse.json(
			{ error: "Only GIPHY media can be fetched" },
			{ status: 400 },
		);
	}

	const response = await fetch(url);
	if (!response.ok || !response.body) {
		return NextResponse.json(
			{ error: `Download failed (${response.status})` },
			{ status: 502 },
		);
	}
	return new NextResponse(response.body, {
		headers: {
			"Content-Type": response.headers.get("content-type") ?? "video/mp4",
			"Cache-Control": "private, max-age=3600",
		},
	});
}
