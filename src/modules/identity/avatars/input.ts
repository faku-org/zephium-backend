import { AppError } from "../../../platform/errors";
import { incomingStart, readIncomingBody } from "../../../platform/incoming-body";
import { avatarFileBytes, avatarRequestBytes, avatarUploadMs } from "./limits";

export async function readAvatar(request: Request): Promise<Buffer> {
  if (!/^multipart\/form-data\s*;/i.test(request.headers.get("content-type") ?? ""))
    throw new AppError("invalid_avatar", 400);
  const remaining = avatarUploadMs - (performance.now() - incomingStart(request));
  if (remaining <= 0 || request.signal.aborted) throw new AppError("request_timeout", 408);
  const bytes = await readIncomingBody(request, avatarRequestBytes, remaining);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(bytes), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    throw new AppError("invalid_avatar", 400);
  }
  const parts = [...form.entries()];
  const file = form.get("file");
  if (parts.length !== 1 || parts[0]?.[0] !== "file" || !(file instanceof Blob) || file.size === 0)
    throw new AppError("invalid_avatar", 400);
  if (file.size > avatarFileBytes || bytes.length - file.size > 16 * 1024)
    throw new AppError("body_too_large", 413);
  if (request.signal.aborted) throw new AppError("request_timeout", 408);
  return Buffer.from(await file.arrayBuffer());
}
