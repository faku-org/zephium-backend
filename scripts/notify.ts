import { sendOperationalNotification } from "../src/platform/notifications";

const url = process.env.OPERATIONS_WEBHOOK;
const event = process.argv[2];
if (!url?.startsWith("https://") || !event || !/^[a-z_]+$/.test(event))
  throw new Error("Notification configuration missing");
await sendOperationalNotification(url, `Zephium operational event: ${event}`);
