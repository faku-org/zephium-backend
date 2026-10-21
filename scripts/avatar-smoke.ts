import sharp from "sharp";
import { processAvatar } from "../src/modules/identity/avatars/processor";

// Synthetic bytes only. Run in the built image and its restricted runtime before qualification.
const input = await sharp({
  create: { width: 16, height: 24, channels: 4, background: { r: 90, g: 60, b: 160, alpha: 0.7 } },
})
  .png()
  .toBuffer();
const output = await processAvatar(input);
const metadata = await sharp(output).metadata();
if (
  metadata.format !== "webp" ||
  metadata.width !== 256 ||
  metadata.height !== 256 ||
  metadata.exif ||
  metadata.icc ||
  metadata.xmp
)
  throw new Error("Avatar runtime verification failed");
console.log("Avatar native subprocess verification passed");
