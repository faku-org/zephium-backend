import { expect, test } from "bun:test";
import { SseFrames } from "../sse";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decode = (bytes: Uint8Array | null) => (bytes === null ? null : decoder.decode(bytes));

test("split CRLF and UTF-8 preserve exact complete-event bytes", () => {
  const frames = new SseFrames();
  const first = 'event: message\r\ndata: {"text":"😀"}\r\n\r\n';
  const second = "data: [DONE]\n\n";
  const wire = encoder.encode(first + second);
  const output: Uint8Array[] = [];
  for (let i = 0; i < wire.length; i++) {
    const complete = frames.push(wire.subarray(i, i + 1));
    if (complete) output.push(complete);
  }
  expect(decoder.decode(Buffer.concat(output))).toBe(first + second);
  expect(frames.finish()).toEqual({ tail: null, truncated: false });
});

test("a complete event is emitted before later chunks arrive", () => {
  const frames = new SseFrames();
  expect(decode(frames.push(encoder.encode("data: first\n\n")))).toBe("data: first\n\n");
  expect(frames.push(encoder.encode("data: later"))).toBeNull();
  expect(decode(frames.push(encoder.encode("\n\n")))).toBe("data: later\n\n");
  expect(frames.finish().truncated).toBe(false);
});

test("unfinished data at EOF is dropped, even after a complete event", () => {
  const frames = new SseFrames();
  expect(decode(frames.push(encoder.encode('data: good\n\ndata: {"partial"')))).toBe(
    "data: good\n\n",
  );
  expect(frames.finish()).toEqual({ tail: null, truncated: true });
});

test("trailing whitespace and comments may pass, but incomplete fields may not", () => {
  const safe = new SseFrames();
  expect(safe.push(encoder.encode("data: good\n\n: keep this comment\r\n  \t"))).not.toBeNull();
  expect(decode(safe.finish().tail)).toBe(": keep this comment\r\n  \t");
  const unsafe = new SseFrames();
  expect(unsafe.push(encoder.encode("event: partial"))).toBeNull();
  expect(unsafe.finish()).toEqual({ tail: null, truncated: true });
});

test("bare CR blank lines complete at EOF without corrupting bytes", () => {
  const frames = new SseFrames();
  expect(frames.push(encoder.encode("data: bare\r\r"))).toBeNull();
  expect(decode(frames.finish().tail)).toBe("data: bare\r\r");
});

test("one incomplete event over 8 MiB is rejected", () => {
  const frames = new SseFrames();
  expect(() => frames.push(encoder.encode(`data: ${"x".repeat(8 * 1024 * 1024)}`))).toThrow();
  const complete = new SseFrames();
  expect(() => complete.push(encoder.encode(`data: ${"x".repeat(8 * 1024 * 1024)}\n\n`))).toThrow();
});
