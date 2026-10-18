const url = process.env.OPERATIONS_WEBHOOK;
const event = process.argv[2];
if (!url?.startsWith("https://") || !event || !/^[a-z_]+$/.test(event))
  throw new Error("Notification configuration missing");
const r = await fetch(url, {
  method: "POST",
  redirect: "error",
  signal: AbortSignal.timeout(10000),
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: `Zephium operational event: ${event}` }),
});
await r.body?.cancel();
if (!r.ok) throw new Error("Notification failed");

export {};
