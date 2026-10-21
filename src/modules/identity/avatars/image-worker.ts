import sharp, { type Metadata } from "sharp";
import { AppError } from "../../../platform/errors";
import { avatarDimension, avatarFileBytes, avatarOutputBytes, avatarPixels } from "./limits";

// This module runs in a short-lived child with no application secrets in its environment.
sharp.cache(false);
sharp.concurrency(1);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function inputFormat(bytes: Buffer): "png" | "jpeg" | "webp" {
  if (bytes.length === 0) throw new AppError("invalid_avatar", 400);
  if (bytes.subarray(0, 8).equals(png)) {
    let at = 8;
    while (at + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(at);
      if (size > bytes.length - at - 12) throw new AppError("invalid_avatar", 400);
      if (bytes.toString("ascii", at + 4, at + 8) === "acTL")
        throw new AppError("unsupported_avatar_format", 415);
      at += size + 12;
    }
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    let at = 2;
    while (at + 4 <= bytes.length && bytes[at] === 255) {
      const marker = bytes[at + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 255) {
        at++;
        continue;
      }
      const size = bytes.readUInt16BE(at + 2);
      if (size < 2 || at + 2 + size > bytes.length) throw new AppError("invalid_avatar", 400);
      if (marker === 0xe2 && bytes.toString("latin1", at + 4, at + 8) === "MPF\0")
        throw new AppError("unsupported_avatar_format", 415);
      at += size + 2;
    }
    return "jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new AppError("invalid_avatar", 400);
    let at = 12;
    while (at + 8 <= bytes.length) {
      const size = bytes.readUInt32LE(at + 4);
      if (size > bytes.length - at - 8) throw new AppError("invalid_avatar", 400);
      const kind = bytes.toString("ascii", at, at + 4);
      if (
        kind === "ANIM" ||
        kind === "ANMF" ||
        (kind === "VP8X" && size >= 1 && (bytes[at + 8] ?? 0) & 2)
      )
        throw new AppError("unsupported_avatar_format", 415);
      at += 8 + size + (size % 2);
    }
    return "webp";
  }
  throw new AppError("unsupported_avatar_format", 415);
}

export async function normalizeAvatar(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > avatarFileBytes) throw new AppError("body_too_large", 413);
  const format = inputFormat(bytes);
  const decoder = sharp(bytes, {
    failOn: "warning",
    limitInputPixels: avatarPixels,
    sequentialRead: true,
  });
  let metadata: Metadata;
  try {
    metadata = await decoder.metadata();
  } catch {
    // Dimensions can be inspected without decoding pixels, then checked explicitly.
    try {
      metadata = await sharp(bytes, { failOn: "warning", limitInputPixels: false }).metadata();
      if (
        metadata.width &&
        metadata.height &&
        (metadata.width > avatarDimension ||
          metadata.height > avatarDimension ||
          metadata.width * metadata.height > avatarPixels)
      )
        throw new AppError("avatar_dimensions_exceeded", 422);
    } catch (error) {
      if (error instanceof AppError) throw error;
    }
    throw new AppError("invalid_avatar", 400);
  }
  if (metadata.format !== format) throw new AppError("unsupported_avatar_format", 415);
  if ((metadata.pages ?? 1) !== 1) throw new AppError("unsupported_avatar_format", 415);
  if (!metadata.width || !metadata.height) throw new AppError("invalid_avatar", 400);
  if (
    metadata.width > avatarDimension ||
    metadata.height > avatarDimension ||
    metadata.width * metadata.height > avatarPixels
  )
    throw new AppError("avatar_dimensions_exceeded", 422);
  try {
    const output = await decoder
      .rotate()
      .resize(256, 256, { fit: "cover", position: "centre" })
      .toColourspace("srgb")
      .webp({ quality: 85, effort: 4 })
      .timeout({ seconds: 5 })
      .toBuffer();
    if (!output.length || output.length > avatarOutputBytes)
      throw new AppError("avatar_processing_failed", 422);
    return output;
  } catch {
    throw new AppError("avatar_processing_failed", 422);
  } finally {
    decoder.destroy();
  }
}

if (import.meta.main) {
  const codes: Record<string, number> = {
    invalid_avatar: 40,
    unsupported_avatar_format: 41,
    avatar_dimensions_exceeded: 42,
    avatar_processing_failed: 43,
    body_too_large: 44,
  };
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > avatarFileBytes) throw new AppError("body_too_large", 413);
      chunks.push(bytes);
    }
    const image = await normalizeAvatar(Buffer.concat(chunks));
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(image, (error) => (error ? reject(error) : resolve())),
    );
  } catch (error) {
    process.exitCode = error instanceof AppError ? (codes[error.code] ?? 45) : 45;
  }
}
