import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppError } from "../../../platform/errors";
import { avatarFileBytes, avatarOutputBytes, avatarProcessingMs } from "./limits";

export type AvatarProcessor = (bytes: Buffer, signal?: AbortSignal) => Promise<Buffer>;
const worker = fileURLToPath(new URL("./image-worker.ts", import.meta.url));
const failures: Record<number, [string, number]> = {
  40: ["invalid_avatar", 400],
  41: ["unsupported_avatar_format", 415],
  42: ["avatar_dimensions_exceeded", 422],
  43: ["avatar_processing_failed", 422],
  44: ["body_too_large", 413],
};
let active = 0;
/** Two processes maximum, no queue; a hard deadline includes startup, metadata and encoding. */
export const processAvatar: AvatarProcessor = async (bytes, signal) => {
  if (signal?.aborted) throw new AppError("request_timeout", 408);
  if (bytes.length > avatarFileBytes) throw new AppError("body_too_large", 413);
  if (active >= 2) throw new AppError("avatar_processing_busy", 503, 1);
  active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(process.execPath, [worker], {
        env: { NODE_ENV: "production", VIPS_CONCURRENCY: "1", MALLOC_ARENA_MAX: "2" },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let failure: AppError | undefined;
      const stop = (error: AppError) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const abort = () => stop(new AppError("request_timeout", 408));
      const timer = setTimeout(
        () => stop(new AppError("avatar_processing_failed", 422)),
        avatarProcessingMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", () => {
        failure ??= new AppError("unavailable", 503);
      });
      child.stdin.on("error", () => {}); // EPIPE after rejection/abort; close determines the result.
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > avatarOutputBytes) stop(new AppError("avatar_processing_failed", 422));
        else chunks.push(chunk);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) failure ??= new AppError("request_timeout", 408);
        if (failure) return reject(failure);
        if (code !== 0 || !size) {
          const mapped = failures[code ?? -1];
          return reject(
            mapped ? new AppError(mapped[0], mapped[1]) : new AppError("unavailable", 503),
          );
        }
        resolve(Buffer.concat(chunks));
      });
      if (signal?.aborted) abort();
      else child.stdin.end(bytes);
    });
  } finally {
    active--;
  }
};
