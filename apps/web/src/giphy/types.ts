export type GiphyKind = "gifs" | "stickers";

export interface GiphyResult {
	id: string;
	title: string;
	previewUrl: string;
	mp4Url: string;
	width?: number;
	height?: number;
}

export interface GiphySearchResponse {
	results: GiphyResult[];
	nextOffset: number | null;
}
