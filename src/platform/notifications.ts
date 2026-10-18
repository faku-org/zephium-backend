const failureMessage = "Operational notification failed";
const telegramResponseLimit = 16 * 1024;

/** Delivery errors must never include the destination URL or response content. */
export async function sendOperationalNotification(
  destination: string,
  text: string,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const url = new URL(destination);
    if (url.protocol !== "https:") throw new Error(failureMessage);
    const telegram =
      url.hostname === "api.telegram.org" && /^\/bot[^/]+\/sendMessage$/i.test(url.pathname);
    let body: object = { text };
    if (telegram) {
      const chatId = url.searchParams.get("chat_id")?.trim();
      if (!chatId) throw new Error(failureMessage);
      url.searchParams.delete("chat_id");
      url.searchParams.delete("text");
      body = { text, chat_id: chatId, link_preview_options: { is_disabled: true } };
    }
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(failureMessage));
      }, 5000);
    });
    const delivery = async () => {
      response = await fetcher(url.href, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(failureMessage);
      if (!telegram) {
        await response.body?.cancel();
        return;
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error(failureMessage);
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > telegramResponseLimit) throw new Error(failureMessage);
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true)
        throw new Error(failureMessage);
    };
    await Promise.race([delivery(), deadline]);
  } catch {
    throw new Error(failureMessage);
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Cancellation must not extend the delivery deadline if a stream misbehaves.
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}
