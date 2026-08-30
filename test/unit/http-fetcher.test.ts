import assert from "node:assert/strict";
import test from "node:test";

import { resolveFinalHttpUrl, SafeHttpFetcher } from "../../src/adapters/http/undici-fetcher.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { Deadline } from "../../src/core/limits.js";
import type { DnsLookup, ResolvedAddress } from "../../src/core/url-policy.js";

async function assertCancellationStopsUrlValidation(
  run: (lookup: DnsLookup, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  const controller = new AbortController();
  const reason = new GroundlaneError("CANCELLED", "dns", "cancel sentinel");
  let addressesInspected = false;
  const addresses = new Proxy<readonly ResolvedAddress[]>(
    [{ address: "93.184.216.34", family: 4 }],
    {
      get(target, property, receiver) {
        if (property === "length") addressesInspected = true;
        return Reflect.get(target, property, receiver) as unknown;
      },
    },
  );
  const lookup: DnsLookup = () => {
    controller.abort(reason);
    return Promise.resolve(addresses);
  };

  await assert.rejects(run(lookup, controller.signal), (error) => error === reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(addressesInspected, false);
}

void test("SafeHttpFetcher forwards cancellation into DNS URL validation", async () => {
  await assertCancellationStopsUrlValidation((lookup, signal) =>
    new SafeHttpFetcher({ lookup }).fetch(
      {
        url: "https://example.com/",
        maxBytes: 1_000,
        maxRedirects: 0,
        deadline: new Deadline(1_000),
      },
      signal,
    ),
  );
});

void test("redirect preflight forwards cancellation into DNS URL validation", async () => {
  await assertCancellationStopsUrlValidation((lookup, signal) =>
    resolveFinalHttpUrl(
      {
        url: "https://example.com/",
        maxRedirects: 0,
        deadline: new Deadline(1_000),
      },
      { lookup },
      signal,
    ),
  );
});
