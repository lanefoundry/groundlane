import type { BrowserBackend, BrowserFetchRequest, RawDocument } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
export class DisabledBrowserBackend implements BrowserBackend {
  ready(): Promise<boolean> { return Promise.resolve(false); }
  fetch(request: BrowserFetchRequest, signal?: AbortSignal): Promise<RawDocument> {
    void request; void signal;
    return Promise.reject(new GroundlaneError("PROVIDER_UNAVAILABLE", "browser", "Browser rendering is disabled"));
  }
}
