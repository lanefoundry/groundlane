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

const SERPER_IMAGES_URL = "https://google.serper.dev/images";

interface SerperImagesOptions {
  apiKey: string;
  fetch?: ImagesFetchLike;
  validateUrl?: ImagesUrlValidator;
}

export class SerperImagesProvider implements ImagesProvider {
  readonly id = "serper" as const;
  private readonly fetcher: ImagesFetchLike;
  private readonly validateUrl: ImagesUrlValidator;

  constructor(private readonly options: SerperImagesOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultImagesUrlValidator;
  }

  supports(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async images(request: ImagesRequest, signal: AbortSignal): Promise<ImagesProviderResult> {
    const started = performance.now();
    const raw = await imagesProviderJson(
      this.fetcher,
      SERPER_IMAGES_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": this.options.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          q: request.query,
          num: request.maxResults,
          gl: request.country?.toLowerCase() ?? "us",
          hl: request.language?.toLowerCase() ?? "en",
          autocorrect: true,
        }),
      },
      signal,
    );
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { images?: unknown }).images)) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_images", "Serper returned a malformed images response", true);
    }
    const items: ImageItem[] = (raw as { images: unknown[] }).images.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const imageUrl = optionalString(item.imageUrl);
      const sourceUrl = optionalString(item.link);
      const title = optionalString(item.title);
      if (imageUrl === undefined || sourceUrl === undefined || title === undefined) return [];
      const imageItem: ImageItem = {
        title,
        imageUrl,
        sourceUrl,
        provider: this.id,
      };
      const thumbnailUrl = optionalString(item.thumbnailUrl);
      const source = optionalString(item.source) ?? optionalString(item.domain);
      const width = optionalPositiveInteger(item.imageWidth);
      const height = optionalPositiveInteger(item.imageHeight);
      const thumbnailWidth = optionalPositiveInteger(item.thumbnailWidth);
      const thumbnailHeight = optionalPositiveInteger(item.thumbnailHeight);
      if (thumbnailUrl !== undefined) imageItem.thumbnailUrl = thumbnailUrl;
      if (source !== undefined) imageItem.source = source;
      if (width !== undefined) imageItem.width = width;
      if (height !== undefined) imageItem.height = height;
      if (thumbnailWidth !== undefined) imageItem.thumbnailWidth = thumbnailWidth;
      if (thumbnailHeight !== undefined) imageItem.thumbnailHeight = thumbnailHeight;
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
