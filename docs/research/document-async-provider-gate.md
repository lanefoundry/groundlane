# Async document provider gate

Checked 2026-09-05 against official pages through Groundlane retrieval.

The PRD's first async document slice requires provider-owned jobs. The current
`DocumentAsyncRuntime` has durable lifecycle and artifact ports, but no adopted
document provider or deployment dispatcher. A synchronous parser wrapped in a
job does not satisfy this boundary.

Reducto now has a bounded candidate adapter and deterministic contracts under
`src/adapters/document/reducto-async.ts`; it is not an enabled provider. It uploads
bytes, creates a provider-owned job, polls persisted job/source receipts, and
maps results to a deliberately partial canonical envelope. Unknown monetary
cost and confidence are `null`; usage credits stay separate. The adapter never
blindly retries submission or treats artifact deletion as processing cancel.
Its [async guide](https://docs.reducto.ai/workflows/async-overview)
documents `POST /parse_async` returning a job ID and `GET /job/{job_id}` for
polling. The guide mentions Pending/InProgress/Completing/Completed/Failed;
the [retrieval OpenAPI](https://docs.reducto.ai/api-reference/retrieve-parse.md)
also includes Idle and uses a different status enumeration. An adapter must
handle the documented variants conservatively. Job-artifact deletion must not
be equated with acknowledged cancellation of processing.

Before adoption: verify upload, result/canonical mapping, unsafe returned URL
handling, response bounds, cancellation semantics, billing provenance and
retention. Add deterministic endpoint/auth/request/response/security contracts,
then opt-in configuration and dispatcher/tool composition. Run a controlled
synthetic provider smoke only with an explicitly configured credential and
bounded allowance. No Reducto credentials or execution have been configured by
this work.

## Candidate adapter contract checked 2026-09-05

The opt-in candidate implementation in `src/adapters/document/reducto-async.ts`
uses actual provider-owned submission and polling I/O, with deterministic
contracts in `test/adapters/reducto-async.test.ts`. It is not enabled, adopted,
deployed, or live-verified by these tests. No paid call was made.

Official sources retrieved through Groundlane establish these wire details:

- [Upload](https://docs.reducto.ai/api-reference/upload.md): multipart `file`
  at `POST /upload` returns `file_id`; only a `reducto://` upload reference is
  submitted to the next endpoint. Initial input scope is byte-sniffed PDF and
  supported images, with fixed MIME and filename extensions.
- [Parse Async](https://docs.reducto.ai/api-reference/parse-async.md):
  `POST /parse_async` accepts `input` and returns `job_id`. No documented
  idempotency header is invented; the durable journal owns at-most-once
  submission attempts and uncertain-acknowledgment handling.
- [Retrieve Job](https://docs.reducto.ai/api-reference/retrieve-parse.md):
  `Completed.result` is a parse response, whose inner `result` is `full` or
  `url`. OpenAPI and the async guide differ on intermediate status names;
  Pending, Idle, InProgress and Completing are handled conservatively.
- [Response format](https://docs.reducto.ai/parse/response-format): a result URL
  downloads a **bare chunk array**, not another full-result wrapper. Downloads
  use the DNS-pinned SafeHttpFetcher with no provider bearer credential and
  retain the polling attempt's deadline, redirect and byte bounds.
- [Delete Job](https://docs.reducto.ai/api-reference/delete-job.md): DELETE
  marks stored artifacts for deletion (retrieval 409, then 410). It does not
  establish processing cancellation. The adapter returns `acknowledged: false`
  for cancellation without issuing DELETE.

The durable provider receipt includes both job ID and source SHA-256 to restore
source identity after restart. Text and page spans are normalized; tables and
figures retain textual content but do not claim cell/image fidelity, and OCR
provenance is not claimed. The canonical result is explicitly partial.
Provider credits and page usage remain separate metadata; unknown monetary
cost and numerical confidence are `null`, with model/version unknown. Provider
payloads, result URLs and credentials are not retained in canonical metadata.
