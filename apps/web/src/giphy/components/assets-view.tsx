"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { addGifToTimeline } from "@/giphy/add-gif";
import type {
	GiphyKind,
	GiphyResult,
	GiphySearchResponse,
} from "@/giphy/types";
import { cn } from "@/utils/ui";

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE = 30;

async function fetchPage({
	query,
	kind,
	offset,
}: {
	query: string;
	kind: GiphyKind;
	offset: number;
}): Promise<GiphySearchResponse> {
	const params = new URLSearchParams({
		type: kind,
		offset: String(offset),
		limit: String(PAGE_SIZE),
	});
	if (query.trim()) {
		params.set("q", query.trim());
	}
	const response = await fetch(`/api/giphy/search?${params}`);
	const body = await response.json();
	if (!response.ok) {
		throw new Error(body.error ?? `Search failed (${response.status})`);
	}
	return body as GiphySearchResponse;
}

export function GiphyView() {
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState<GiphyKind>("gifs");
	const [results, setResults] = useState<GiphyResult[]>([]);
	const [nextOffset, setNextOffset] = useState<number | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [addingId, setAddingId] = useState<string | null>(null);

	useEffect(() => {
		let ignore = false;
		const timeoutId = setTimeout(async () => {
			setIsLoading(true);
			setError(null);
			try {
				const page = await fetchPage({ query, kind, offset: 0 });
				if (!ignore) {
					setResults(page.results);
					setNextOffset(page.nextOffset);
				}
			} catch (err) {
				if (!ignore) {
					setResults([]);
					setNextOffset(null);
					setError(err instanceof Error ? err.message : "Search failed");
				}
			} finally {
				if (!ignore) {
					setIsLoading(false);
				}
			}
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			ignore = true;
			clearTimeout(timeoutId);
		};
	}, [query, kind]);

	const loadMore = useCallback(async () => {
		if (nextOffset === null || isLoading) {
			return;
		}
		setIsLoading(true);
		try {
			const page = await fetchPage({ query, kind, offset: nextOffset });
			setResults((current) => [...current, ...page.results]);
			setNextOffset(page.nextOffset);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Could not load more");
		} finally {
			setIsLoading(false);
		}
	}, [isLoading, kind, nextOffset, query]);

	const { scrollAreaRef, handleScroll } = useInfiniteScroll({
		onLoadMore: loadMore,
		hasMore: nextOffset !== null,
		isLoading,
	});

	const addGif = async ({ gif }: { gif: GiphyResult }) => {
		setAddingId(gif.id);
		try {
			await addGifToTimeline({ gif });
		} catch (err) {
			toast.error("Could not add GIF", {
				description: err instanceof Error ? err.message : undefined,
			});
		} finally {
			setAddingId(null);
		}
	};

	return (
		<div className="flex h-full flex-col py-2">
			<div className="px-2">
				<Input
					size="sm"
					variant="default"
					placeholder="Search GIPHY..."
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					showClearIcon
					onClear={() => setQuery("")}
					className="w-full"
					containerClassName="w-full"
				/>
			</div>

			<Tabs
				value={kind}
				onValueChange={(value) => setKind(value as GiphyKind)}
				variant="underline"
				className="mt-2 flex min-h-0 flex-1 flex-col"
			>
				<TabsList aria-label="GIPHY content type">
					<TabsTrigger value="gifs">GIFs</TabsTrigger>
					<TabsTrigger value="stickers">Stickers</TabsTrigger>
				</TabsList>
				<div
					ref={scrollAreaRef}
					onScroll={handleScroll}
					className="min-h-0 flex-1 overflow-y-auto px-2 pt-3"
				>
					{error ? (
						<p className="text-muted-foreground p-4 text-center text-sm text-balance">
							{error}
						</p>
					) : (
						<div className="columns-2 gap-2">
							{results.map((gif) => (
								<button
									key={gif.id}
									type="button"
									title={gif.title ? `Add "${gif.title}"` : "Add GIF"}
									disabled={addingId !== null}
									onClick={() => void addGif({ gif })}
									className={cn(
										"bg-accent relative mb-2 block w-full overflow-hidden rounded-sm",
										"hover:ring-primary hover:ring-2 disabled:cursor-wait",
									)}
								>
									<Image
										src={gif.previewUrl}
										alt={gif.title}
										width={gif.width ?? 200}
										height={gif.height ?? 200}
										unoptimized
										className="h-auto w-full"
									/>
									{addingId === gif.id && (
										<div className="bg-background/60 absolute inset-0 flex items-center justify-center">
											<Spinner className="size-5" />
										</div>
									)}
								</button>
							))}
						</div>
					)}
					{isLoading && (
						<div className="flex justify-center py-4">
							<Spinner className="text-muted-foreground size-5" />
						</div>
					)}
					{!isLoading && !error && results.length === 0 && (
						<p className="text-muted-foreground p-4 text-center text-sm">
							No results
						</p>
					)}
				</div>
			</Tabs>
			<p className="text-muted-foreground px-2 pt-2 text-right text-[10px]">
				Powered by GIPHY · added at the playhead on a new top layer
			</p>
		</div>
	);
}
