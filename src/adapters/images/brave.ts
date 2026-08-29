import type { ImageItem, ImagesProvider, ImagesProviderResult, ImagesRequest } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import {
  defaultImagesUrlValidator,
  imagesProviderJson,
  imagesResult,
  normalizeImageItems,
  optionalPositiveInteger,
  optionalString,
  type ImagesFetchLike,
  type ImagesUrlValidator,
} from "./common.js";

interface BraveImagesOptions {
  apiKey: string;
  fetch?: ImagesFetchLike;
  validateUrl?: ImagesUrlValidator;
}

const safeSearch: Record<NonNullable<ImagesRequest["safeSearch"]>, string> = {
  off: "off",
  moderate: "moderate",
  strict: "strict",
};

export class BraveImagesProvider implements ImagesProvider {
  readonly id = "brave" as const;
  private readonly fetcher: ImagesFetchLike;
  private readonly validateUrl: ImagesUrlValidator;

  constructor(private readonly options: BraveImagesOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultImagesUrlValidator;
  }

  supports(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async images(request: ImagesRequest, signal: AbortSignal): Promise<ImagesProviderResult> {
    const started = performance.now();
    const url = new URL("https://api.search.brave.com/res/v1/images/search");
    url.searchParams.set("q", request.query);
    url.searchParams.set("count", String(request.maxResults));
    url.searchParams.set("country", request.country?.toUpperCase() ?? "US");
    url.searchParams.set("search_lang", request.language?.toLowerCase() ?? "en");
    url.searchParams.set("safesearch", safeSearch[request.safeSearch ?? "moderate"]);
    const raw = await imagesProviderJson(
      this.fetcher,
      url.href,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-subscription-token": this.options.apiKey,
        },
      },
      signal,
    );
    const values =
      raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : undefined;
    if (values === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_images", "Brave returned a malformed images response", true);
    }
    const items: ImageItem[] = values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const properties = item.properties && typeof item.properties === "object"
        ? item.properties as Record<string, unknown>
        : {};
      const thumbnail = item.thumbnail && typeof item.thumbnail === "object"
        ? item.thumbnail as Record<string, unknown>
        : {};
      const imageUrl = optionalString(properties.url) ?? optionalString(item.image_url) ?? optionalString(item.url);
      const sourceUrl = optionalString(item.url) ?? optionalString(item.source_url);
      const title = optionalString(item.title);
      if (imageUrl === undefined || sourceUrl === undefined || title === undefined) return [];
      const imageItem: ImageItem = {
        title,
        imageUrl,
        sourceUrl,
        provider: this.id,
      };
      const thumbnailUrl = optionalString(thumbnail.src);
      const source = optionalString(item.source);
      const width = optionalPositiveInteger(properties.width);
      const height = optionalPositiveInteger(properties.height);
      if (thumbnailUrl !== undefined) imageItem.thumbnailUrl = thumbnailUrl;
      if (source !== undefined) imageItem.source = source;
      if (width !== undefined) imageItem.width = width;
      if (height !== undefined) imageItem.height = height;
      return [imageItem];
    });
    return imagesResult(
      this.id,
      request.query,
      await normalizeImageItems(this.id, items, this.validateUrl),
      started,
    );
  }
}
