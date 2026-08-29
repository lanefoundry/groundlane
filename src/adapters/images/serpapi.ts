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

interface SerpApiImagesOptions {
  apiKey: string;
  fetch?: ImagesFetchLike;
  validateUrl?: ImagesUrlValidator;
}

export class SerpApiImagesProvider implements ImagesProvider {
  readonly id = "serpapi" as const;
  private readonly fetcher: ImagesFetchLike;
  private readonly validateUrl: ImagesUrlValidator;

  constructor(private readonly options: SerpApiImagesOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultImagesUrlValidator;
  }

  supports(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async images(request: ImagesRequest, signal: AbortSignal): Promise<ImagesProviderResult> {
    const started = performance.now();
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_images");
    url.searchParams.set("q", request.query);
    url.searchParams.set("api_key", this.options.apiKey);
    url.searchParams.set("gl", request.country?.toLowerCase() ?? "us");
    url.searchParams.set("hl", request.language?.toLowerCase() ?? "en");
    url.searchParams.set("safe", request.safeSearch === "off" ? "off" : "active");

    const raw = await imagesProviderJson(
      this.fetcher,
      url.href,
      { method: "GET", headers: { accept: "application/json" } },
      signal,
    );
    if (raw && typeof raw === "object" && typeof (raw as { error?: unknown }).error === "string") {
      const message = (raw as { error: string }).error;
      if (/rate|limit|credit|searches/iu.test(message)) {
        throw new GroundlaneError("RATE_LIMITED", "web_images", "SerpApi quota or rate limit reached", true);
      }
      throw new GroundlaneError("UPSTREAM_ERROR", "web_images", "SerpApi rejected the images request");
    }
    const values =
      raw && typeof raw === "object" && Array.isArray((raw as { images_results?: unknown }).images_results)
        ? (raw as { images_results: unknown[] }).images_results
        : undefined;
    if (values === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_images", "SerpApi returned a malformed images response", true);
    }
    const items: ImageItem[] = values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const imageUrl = optionalString(item.original);
      const sourceUrl = optionalString(item.link);
      const title = optionalString(item.title);
      if (imageUrl === undefined || sourceUrl === undefined || title === undefined) return [];
      const imageItem: ImageItem = {
        title,
        imageUrl,
        sourceUrl,
        provider: this.id,
      };
      const thumbnailUrl = optionalString(item.thumbnail);
      const source = optionalString(item.source);
      const width = optionalPositiveInteger(item.original_width);
      const height = optionalPositiveInteger(item.original_height);
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
