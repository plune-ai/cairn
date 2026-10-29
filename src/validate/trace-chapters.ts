import { inflateRawSync } from "node:zlib";

/**
 * #214: exact chapter offsets from the Playwright trace that sits beside each `.webm` (#210).
 *
 * The `.webm` starts at the first screencast frame: Playwright places every frame at its `frameSwapWallTime` minus the
 * first frame's. The JSON reporter gives no step start time, so the old offsets summed step durations from the start of
 * the first hook, and the first scenario of a worker - whose Before Hooks launch the browser - came out seconds late.
 * The trace has both clocks: the runner's `test.trace` the steps, the context's `*-trace.trace` the frames.
 */

/** The names of a zip archive, each with a reader for its bytes. Stored (0) and deflated (8) entries, which is what Playwright writes; stdlib only. */
function zipEntries(zip: Buffer): Map<string, () => Buffer> {
  // The end-of-central-directory record: the last 22 bytes, or further back by the length of a trailing comment.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, () => Buffer>();
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("broken zip central directory");
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    out.set(name, () => {
      // The local header repeats the name and has its own extra field; the data starts after both.
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`zip method ${method} is not supported`);
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

interface TraceEvent {
  type?: string;
  wallTime?: number;
  monotonicTime?: number;
  startTime?: number;
  method?: string;
  parentId?: string;
  title?: string;
  timestamp?: number;
  frameSwapWallTime?: number;
}

function events(bytes: Buffer): TraceEvent[] {
  return bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TraceEvent);
}

/** A trace file's monotonic clock read as wall time, from its `context-options` pair; `undefined` without one. */
function wallClock(list: TraceEvent[]): ((monotonic: number) => number) | undefined {
  const options = list.find((e) => e.type === "context-options");
  if (options?.wallTime === undefined || options.monotonicTime === undefined) return undefined;
  const shift = options.wallTime - options.monotonicTime;
  return (monotonic) => monotonic + shift;
}

/** The top-level `test.step`s of a trace, each with its offset (ms) from the first frame of the video; `undefined` when the trace has no frame or no clock. */
export function stepsFromTrace(zip: Buffer): { title: string; atMs: number }[] | undefined {
  const entries = zipEntries(zip);
  const runner = entries.get("test.trace");
  if (runner === undefined) return undefined;
  const steps = events(runner());
  const stepWall = wallClock(steps);
  if (stepWall === undefined) return undefined;

  let first: number | undefined;
  for (const [name, read] of entries) {
    if (!/^\d+-trace\.trace$/.test(name)) continue; // one file per browser context
    const list = events(read());
    const frameWall = wallClock(list);
    for (const e of list) {
      if (e.type !== "screencast-frame") continue;
      // The video places a frame by `frameSwapWallTime`; an older trace without it falls back to its receipt time.
      const wall = e.frameSwapWallTime ?? (e.timestamp !== undefined && frameWall !== undefined ? frameWall(e.timestamp) : undefined);
      if (wall !== undefined && (first === undefined || wall < first)) first = wall;
    }
  }
  if (first === undefined) return undefined;

  return steps
    .filter((e) => e.type === "before" && e.method === "test.step" && e.parentId === undefined && e.startTime !== undefined)
    .map((e) => ({
      title: e.title ?? "(step)",
      // A step that began before the first frame (the first scenario of a worker) is at the start of the video.
      atMs: Math.max(0, Math.round(stepWall(e.startTime!) - first!)),
    }));
}
