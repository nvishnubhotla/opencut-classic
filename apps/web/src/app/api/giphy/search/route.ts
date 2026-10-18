import { webEnv } from "@/env/web";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const searchParamsSchema = z.object({
	q: z.string().max(200, "Query too long").optional(),
	type: z.enum(["gifs", "stickers"]).default("gifs"),
	offset: z.coerce.number().int().min(0).max(4999).default(0),
	limit: z.coerce.number().int().min(1).max(50).default(30),
});

const renditionSchema = z.object({
	url: z.string().optional(),
	mp4: z.string().optional(),
	webp: z.string().optional(),
	width: z.coerce.number().optional(),
	height: z.coerce.number().optional(),
});

const giphyResponseSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			title: z.string().default(""),
			images: z.object({
				original: renditionSchema,
				fixed_width: renditionSchema.optional(),
			}),
		}),
	),
	pagination: z.object({
		total_count: z.number().optional(),
		count: z.number(),
		offset: z.number(),
	}),
});

export async function GET(request: NextRequest) {
	const apiKey = webEnv.GIPHY_API_KEY;
	if (!apiKey) {
		return NextResponse.json(
			{ error: "GIPHY_API_KEY is not set in apps/web/.env.local" },
			{ status: 503 },
		);
	}

	const parsed = searchParamsSchema.safeParse(
		Object.fromEntries(request.nextUrl.searchParams),
	);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid parameters", details: parsed.error.flatten().fieldErrors },
			{ status: 400 },
		);
	}
	const { q, type, offset, limit } = parsed.data;
	const query = q?.trim();

	// Empty query shows what's trending.
	const url = new URL(
		`https://api.giphy.com/v1/${type}/${query ? "search" : "trending"}`,
	);
	url.searchParams.set("api_key", apiKey);
	url.searchParams.set("limit", String(limit));
	url.searchParams.set("offset", String(offset));
	url.searchParams.set("rating", "pg-13");
	if (query) {
		url.searchParams.set("q", query);
	}

	const response = await fetch(url);
	if (!response.ok) {
		return NextResponse.json(
			{ error: `GIPHY request failed (${response.status})` },
			{ status: 502 },
		);
	}

	const body = giphyResponseSchema.safeParse(await response.json());
	if (!body.success) {
		return NextResponse.json(
			{ error: "Unexpected response from GIPHY" },
			{ status: 502 },
		);
	}

	const results = body.data.data
		.map((item) => {
			const preview = item.images.fixed_width ?? item.images.original;
			return {
				id: item.id,
				title: item.title,
				previewUrl: preview.webp ?? preview.url,
				mp4Url: item.images.original.mp4,
				width: item.images.original.width,
				height: item.images.original.height,
			};
		})
		.filter((item) => item.previewUrl && item.mp4Url);

	const { count, offset: pageOffset, total_count } = body.data.pagination;
	return NextResponse.json({
		results,
		nextOffset:
			total_count !== undefined && pageOffset + count >= total_count
				? null
				: pageOffset + count,
	});
}
