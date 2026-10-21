import { expect, test } from "bun:test";
import sharp from "sharp";
import { normalizeAvatar } from "../avatars/image-worker";
import { readAvatar } from "../avatars/input";
import { avatarFileBytes, avatarOutputBytes, avatarRequestBytes } from "../avatars/limits";
import { processAvatar } from "../avatars/processor";

async function image(format: "png" | "jpeg" | "webp") {
  return sharp({ create: { width: 321, height: 199, channels: 4, background: "#ed5a2280" } })
    [format]()
    .toBuffer();
}
function multipart(form: FormData) {
  return new Request("http://localhost/v1/account/avatar", { method: "PUT", body: form });
}
function fileForm(bytes: Buffer, type = "image/png") {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), "ignored.svg");
  return form;
}

test("bounded subprocess decodes PNG, JPEG and WebP to a single 256px WebP", async () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const original = await image(format);
    const output = await processAvatar(original);
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 256, height: 256, space: "srgb" });
    expect(metadata.pages ?? 1).toBe(1);
    expect(metadata.hasAlpha).toBe(format !== "jpeg");
    expect(output.length).toBeLessThanOrEqual(avatarOutputBytes);
    expect(output.equals(original)).toBe(false);
  }
});

test("EXIF orientation precedes crop and all embedded metadata is stripped", async () => {
  const pixels = Buffer.alloc(512 * 256 * 3);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 512; x++) pixels[(y * 512 + x) * 3 + (x < 256 ? 0 : 2)] = 255;
  }
  const original = await sharp(pixels, { raw: { width: 512, height: 256, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Artist: "PRIVATE EXIF marker" } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">PRIVATE XMP marker</x:xmpmeta>')
    .jpeg({ quality: 95 })
    .toBuffer();
  const before = await sharp(original).metadata();
  expect(before.orientation).toBe(6);
  expect(before.exif).toBeDefined();
  expect(before.icc).toBeDefined();
  expect(before.xmp).toBeDefined();
  const output = await normalizeAvatar(original);
  const metadata = await sharp(output).metadata();
  for (const key of ["orientation", "exif", "xmp", "icc", "iptc", "comments"] as const)
    expect(metadata[key]).toBeUndefined();
  const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  const top = (32 * info.width + 128) * info.channels;
  const bottom = (224 * info.width + 128) * info.channels;
  expect(data[top]).toBeGreaterThan(230);
  expect(data[top + 2]).toBeLessThan(20);
  expect(data[bottom]).toBeLessThan(20);
  expect(data[bottom + 2]).toBeGreaterThan(230);
});

test("center crop discards non-square outer edges and keeps alpha", async () => {
  const pixels = Buffer.alloc(600 * 200 * 4);
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 600; x++) {
      const at = (y * 600 + x) * 4;
      pixels[at + (x >= 200 && x < 400 ? 1 : 0)] = 255;
      pixels[at + 3] = 128;
    }
  }
  const original = await sharp(pixels, { raw: { width: 600, height: 200, channels: 4 } })
    .png()
    .toBuffer();
  const output = await normalizeAvatar(original);
  const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(4);
  const center = (128 * info.width + 128) * info.channels;
  expect(data[center]).toBeLessThan(20);
  expect(data[center + 1]).toBeGreaterThan(230);
  expect(data[center + 3]).toBe(128);
});

test("animation, SVG, GIF and forged multipart MIME cannot bypass decoded format validation", async () => {
  const frames = Buffer.alloc(8 * 16 * 3);
  frames.fill(255, 0, 8 * 8 * 3);
  const animated = await sharp(frames, {
    raw: { width: 8, height: 16, pageHeight: 8, channels: 3 },
  })
    .webp({ delay: [40, 40], loop: 0 })
    .toBuffer();
  expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2);
  for (const bytes of [
    animated,
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from("GIF89a"),
  ]) {
    const uploaded = await readAvatar(multipart(fileForm(bytes, "image/png")));
    await expect(normalizeAvatar(uploaded)).rejects.toMatchObject({
      code: "unsupported_avatar_format",
      status: 415,
    });
  }
  const png = await image("png");
  expect((await readAvatar(multipart(fileForm(png, "image/svg+xml")))).equals(png)).toBe(true);
  expect((await sharp(await normalizeAvatar(png)).metadata()).format).toBe("webp");
});

test("empty, truncated and malformed image bytes have stable errors", async () => {
  await expect(normalizeAvatar(Buffer.alloc(0))).rejects.toMatchObject({ code: "invalid_avatar" });
  const png = await image("png");
  await expect(processAvatar(png.subarray(0, 24))).rejects.toMatchObject({
    code: "invalid_avatar",
    status: 400,
  });
  const webp = await image("webp");
  await expect(normalizeAvatar(webp.subarray(0, webp.length - 1))).rejects.toMatchObject({
    code: "invalid_avatar",
    status: 400,
  });
});

test("encoded bytes, pixel count and either dimension are bounded before resize", async () => {
  await expect(processAvatar(Buffer.alloc(avatarFileBytes + 1))).rejects.toMatchObject({
    code: "body_too_large",
    status: 413,
  });
  for (const [width, height] of [
    [8193, 1],
    [1, 8193],
    [4097, 4096],
  ] as const) {
    const original = await sharp({ create: { width, height, channels: 3, background: "white" } })
      .png()
      .toBuffer();
    expect(original.length).toBeLessThan(avatarFileBytes);
    await expect(normalizeAvatar(original)).rejects.toMatchObject({
      code: "avatar_dimensions_exceeded",
      status: 422,
    });
  }
});

test("multipart accepts exactly one nonempty file and rejects duplicate/unknown/string fields", async () => {
  const png = await image("png");
  const forms = [
    new FormData(),
    fileForm(Buffer.alloc(0)),
    fileForm(png),
    fileForm(png),
    new FormData(),
  ];
  forms[2]?.append("file", new Blob([new Uint8Array(png)]), "duplicate.png");
  forms[3]?.append("url", "https://example.test/image.png");
  forms[4]?.append("file", "https://example.test/image.png");
  for (const form of forms)
    await expect(readAvatar(multipart(form))).rejects.toMatchObject({
      code: "invalid_avatar",
      status: 400,
    });
  for (const type of ["multipart/form-data; boundary=broken", "application/json"])
    await expect(
      readAvatar(
        new Request("http://localhost/v1/account/avatar", {
          method: "PUT",
          headers: { "content-type": type },
          body: "broken",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_avatar", status: 400 });
});

test("multipart enforces both file and total request byte limits", async () => {
  await expect(
    readAvatar(multipart(fileForm(Buffer.alloc(avatarFileBytes + 1)))),
  ).rejects.toMatchObject({ code: "body_too_large", status: 413 });
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([1])]), "x".repeat(avatarRequestBytes));
  await expect(readAvatar(multipart(form))).rejects.toMatchObject({
    code: "body_too_large",
    status: 413,
  });
  expect((await readAvatar(multipart(fileForm(Buffer.alloc(avatarFileBytes))))).length).toBe(
    avatarFileBytes,
  );
});

test("an already aborted upload or transform cannot continue", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = new Request(multipart(fileForm(await image("png"))), {
    signal: controller.signal,
  });
  await expect(readAvatar(request)).rejects.toMatchObject({ code: "request_timeout", status: 408 });
  await expect(processAvatar(await image("png"), controller.signal)).rejects.toMatchObject({
    code: "request_timeout",
    status: 408,
  });
});

test("subprocess admission is bounded with no queue and aborted workers release their slot", async () => {
  const original = await image("png");
  const results = await Promise.allSettled([
    processAvatar(original),
    processAvatar(original),
    processAvatar(original),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
    code: "avatar_processing_busy",
    status: 503,
    retryAfter: 1,
  });
  const controller = new AbortController();
  const interrupted = processAvatar(original, controller.signal).then(
    () => null,
    (error: unknown) => error,
  );
  controller.abort();
  expect(await interrupted).toMatchObject({ code: "request_timeout", status: 408 });
  const recovered = await Promise.all([processAvatar(original), processAvatar(original)]);
  expect(recovered.every((output) => output.length > 0)).toBe(true);
});
