# Failure variants of an eval: `cairn propose-failures`

`cairn propose-failures` takes one eval of your `plune.yaml` and proposes variants of it in which the model provider
fails: a server error, a rate limit, a dropped connection, a request that is never answered, a slow answer, an answer cut
in the middle. It calls no model and costs nothing. A person reviews every variant; nothing is run and `plune.yaml` is
only read.

It is built like [`cairn mcp-test --propose-scenarios`](./mcp-test.md#5-propose-agent-scenarios-paid-optional): a file
with proposals next to the run, and a report for the review queue of Plune.

> **What a variant checks, and what it does not.** The stub server answers the model call that the `plune run` client
> itself makes. So a variant says how the *eval* survives the failure: its prompt, its checks, the client's retries and
> timeout. It does not test your product: your product's own calls to the provider are not part of an eval. To test
> those, serve a stub file to your product with `plune mock` (see the
> [guide of the CLI](https://docs.plune.ai/cli/guides/test-provider-failures/)).

## Where the answer comes from

Cairn does not write the provider's answer and does not ask a model for one. The answer that arrives after the failure is
one **you recorded** from the provider with `plune mock --record` (CLI 0.40.0 or newer) while the eval ran. Cairn reads
that recording, takes the stubs that answer this eval, and adds a `failure` to each. Nothing else in a stub changes:
the request it matches and the response it gives are the recorded ones.

So the order is:

1. Record the eval's own model call once: start `plune mock <file> --record --target <the provider's origin>`, point the
   client of `plune run` at the address it prints, and run the eval. How a recording works and what it stores is in the
   [guide of the CLI](https://docs.plune.ai/cli/guides/test-provider-failures/#record-a-stub-file-from-a-live-api).
   A recording holds your prompts and the answers word for word: read it before you commit it.
2. Run `cairn propose-failures` on the eval and that recording.
3. Review the variants, in the file or in the review queue, and move the ones you agree with into `plune.yaml`.

## Run it

The command and its output below are real. They were run from this repository's source tree on a `plune.yaml` with one
eval, `refund-answer`, and a recording the recorder of `@plune-ai/cli` 0.40.1 wrote for it. No provider was called to
make them: a local stub server stood in for the provider while recording. Paths are shown relative to the folder the
command ran in.

```text
cairn propose-failures --eval refund-answer --recording recorded.stubs.yaml --out runs/failures
```

```text
Failure variants of eval "refund-answer": 5 proposed, 1 rejected: runs/failures/plune.failures.proposed.yaml
  refund-answer-http-500: http_500 (first 2)
  refund-answer-http-429: http_429 (first 1)
  refund-answer-reset: reset (first 1)
  refund-answer-slow-stream: slow_stream
  refund-answer-truncated-json: truncated_json
  rejected refund-answer-timeout: provider.timeout is not set: only the client's own timeout ends such a call, and plune run refuses a timeout stub without it
  Stub files (they hold the recorded prompts and answers): runs/failures/stubs
  Review queue: plune ingest runs/failures/variants
  No model was called. Nothing was run and plune.yaml was not changed.
exit 0
```

| Flag | Default | Meaning |
|---|---|---|
| `--eval <id>` | required | the id of the eval in `plune.yaml` to make variants of |
| `--recording <file>` | required | the stub file recorded with `plune mock --record` while that eval ran; it is only read |
| `--plune-config <file>` | `plune.yaml` | the `plune.yaml` that holds the eval; it is only read |
| `--failures <kinds>` | all six | failure kinds to propose, comma separated |
| `--out <dir>` | `runs/failures-<id>/` | where the files are written |

## What it writes

| File | What is in it |
|---|---|
| `plune.failures.proposed.yaml` | each variant as an `evals` entry: the eval as you wrote it, with a new id and a `stubs:` line |
| `stubs/<variant id>.stubs.yaml` | the stub file of the variant: the recorded stubs of the eval, each with the failure |
| `failure-variants.json` | how many were proposed, and the rejected ones with their reasons |
| `variants/report.json` | the same variants as a run of designed cases, for the review queue |

One entry of `plune.failures.proposed.yaml` from the run above. The comment names the eval it is a variant of; the lines
after `stubs:` are the lines of `refund-answer` in `plune.yaml`, unchanged:

```yaml
  # Variant of eval "refund-answer": when the first 2 calls to the provider end with HTTP 500 (http_500).
  - id: refund-answer-http-500
    stubs: "stubs/refund-answer-http-500.stubs.yaml"
    description: The refund question gets an approval.
    prompt: "Can order {{order}} be refunded?"
    dataset:
      examples:
        - vars: { order: 1042 }
    assertions:
      - type: contains
        value: "Refund approved"
```

Its stub file is the recorded stub with these lines added, and nothing else changed:

```json
      "failure": {
        "type": "http_500",
        "first": 2
      }
```

The stub files hold the recorded prompts and answers, as the recording does. Read them before you commit them.

## The six variants

The failure kinds are the six of the stub file format. For each, the variant's stub is the recorded answer plus:

| Variant id ends with | `failure` | What the variant expects of `plune run` |
|---|---|---|
| `-http-500` | `http_500`, `first: 2` (or `first: 1` when `provider.max_retries` is 1) | passes: the client tries again and gets the recorded answer |
| `-http-429` | `http_429`, `first: 1`, `retry_after_seconds: 1` | passes, after the second the header names |
| `-reset` | `reset`, `first: 1` | passes: the dropped connection is tried again |
| `-timeout` | `timeout`, `first: 1` | passes: the first call ends at `provider.timeout` and is tried again |
| `-slow-stream` | `slow_stream`, `bytes_per_sec: 256` | passes, later: the whole answer arrives slowly |
| `-truncated-json` | `truncated_json` | the row is errored and the run exits `2`: a cut body is not tried again by CLI 0.40 |

A variant that cannot work is not written. It is listed as rejected, with the reason, in the output and in
`failure-variants.json`:

- `-timeout` without `provider.timeout`: only the client's own timeout ends such a call, and `plune run` refuses the stub;
- the four variants that need a second call, when `provider.max_retries` is `0`;
- `-truncated-json`, when the recorded answer is a stream or a text and not JSON;
- a variant whose id `plune.yaml` already has.

When every kind is rejected the files are still written and the command exits `1`.

## Review and run a variant

Send the variants to the review queue of Plune with `plune ingest runs/failures/variants`. Each one is a proposal there,
with no verdict. Its title names the eval it is a variant of (`Eval "refund-answer" when the first 2 calls to the
provider end with HTTP 500 (http_500)`), its steps say what to move and what to run, and its explanation says the same
in a sentence. `@plune-ai/cli` 0.40.1 sends the proposal without the explanation (the `rationale` of the case in
`report.json`); the eval is named in the title either way. Nothing is created until a person accepts the proposal.

**An accepted variant has no results on the platform.** A run answered from stubs is not a measurement of the model, so
`plune sync` refuses it. The case in the queue is a description; the variant itself runs on your machine and in CI.

To run one, move its entry from `plune.failures.proposed.yaml` into `plune.yaml` and copy its stub file to the same path
next to `plune.yaml` (`stubs/refund-answer-http-500.stubs.yaml`). Then:

```text
plune run --only refund-answer-http-500
```

This was done with the variants above and `@plune-ai/cli` 0.40.1. The variant with two failed calls passed after the
client's two retries:

```text
Plune run
1 passed · 0 failed · 0 errored · 1 total · $0.0000 · 1626ms
stability: not measured (runs: 1)

PASS refund-answer-http-500
  1 row(s) passed
exit 0
```

With `max_retries: 0` on the provider, the same variant errored, which shows the failure is really served:

```text
FAIL refund-answer-http-500
  vars: {"order":1042}
  error: 500 {"type":"error","error":{"type":"api_error","code":"internal_error","message":"Internal server error (stub)"}}
exit 2
```

And the cut answer errored its row, as the variant says:

```text
FAIL refund-answer-truncated-json
  vars: {"order":1042}
  error: terminated
exit 2
```

## When it refuses

Each of these ends with exit `1` and writes nothing:

```text
✗ propose-failures: the recording was not found: nope.stubs.yaml. Record the eval's own call with plune mock --record and name the file with --recording.
✗ propose-failures: the recording holds no answer for eval "refund-answer": no POST stub with body.model "example-model" and a 2xx response with a body. Record the eval's own call with plune mock --record first.
✗ propose-failures: no eval "ghost" under evals: in the plune.yaml (it is read line by line: a block list of "- id: ghost" items).
```

(The second line is shown with the model's name replaced by `example-model`.) An eval with `mcp` is refused too: a stub
file answers the model call of an eval without `mcp`. So is a `--failures` name that is not one of the six.

## Limits

- **It tests the eval, not your product.** See the note at the top.
- **A recorded answer is found by the model's name.** The stubs taken for the eval are the recorded `POST` requests whose
  body names the eval's `provider.model` (the eval's own, or the one at the root of `plune.yaml`) and whose response is a
  2xx with a body. Two evals that use the same model and were recorded into one file both get their stubs in the
  variant's file; `plune run` then warns about the stubs no request reached. Record one eval per file to avoid it.
- **`plune.yaml` is read line by line, not parsed.** `evals` has to be a block list (`- id: refund-answer` items, one
  key per line), and the provider's `model`, `timeout` and `max_retries` plain values. An eval written another way is
  reported as not found. A matrix of models is not read.
- **The recording is read in the form the recorder writes it**: comment lines, then JSON. A stub file rewritten by hand
  as YAML is refused. At most 1 MiB, which is also the most `plune run` reads.
- **A request recorded more than once keeps its last recording.** The recorder replays repeats in order; a failure that
  counts calls needs one stub per request, so the earlier recordings are left out and the output says how many.
- **Judge calls are not stubbed.** An eval with a model-graded check still asks the real provider for the judgement, at
  its price, as in any stubbed run.
- **Retries and the cut body follow the CLI.** The expectations in the table are those of `@plune-ai/cli` 0.40; a later
  CLI that tries a cut body again would pass the `-truncated-json` variant.

## See also

- [Test provider failures](https://docs.plune.ai/cli/guides/test-provider-failures/): the stub file format, `stubs:` on
  an eval, `plune mock` and its recorder.
- [`cairn mcp-test --propose-scenarios`](./mcp-test.md#5-propose-agent-scenarios-paid-optional): the other command that
  writes proposals for `plune.yaml`.
