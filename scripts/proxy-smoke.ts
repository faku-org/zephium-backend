import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApiServer } from "../src/apps/api/server";

// Explicit local smoke only: no provider calls, account data, or public listener.
const loopback = "127.0.0.1";
const host = "api.zephium.app";
const encoder = new TextEncoder();

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done, fail) => {
    probe.once("error", fail);
    probe.listen(0, loopback, done);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port");
  await new Promise<void>((done) => probe.close(() => done()));
  return address.port;
}

function https(port: number, path: string, method = "GET", canary = ""): Promise<IncomingMessage> {
  return new Promise((done, fail) => {
    const req = httpsRequest(
      {
        hostname: loopback,
        port,
        path,
        method,
        servername: host,
        rejectUnauthorized: false, // Only this smoke request trusts the temporary self-signed cert.
        headers: {
          Host: host,
          Accept: "text/event-stream",
          "Accept-Encoding": "gzip, deflate, br",
          "Content-Type": "application/json",
          "X-Smoke-Canary": canary,
        },
      },
      done,
    );
    req.once("error", fail);
    req.setTimeout(10_000, () => req.destroy(new Error("Local Traefik request timed out")));
    req.end(method === "POST" ? "{}" : undefined);
  });
}

const temporary = await mkdtemp(join(tmpdir(), "zephium-proxy-smoke-"));
let releaseFinal!: () => void;
const finalGate = new Promise<void>((done) => {
  releaseFinal = done;
});
let finalReleased = false;
let proxy: ReturnType<typeof spawn> | null = null;
let proxyExited: Promise<number | null> | null = null;
let proxyOutput = "";
let origin: ReturnType<typeof createApiServer> | null = null;

try {
  const certificate = join(temporary, "cert.pem");
  const privateKey = join(temporary, "key.pem");
  const cert = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=DNS:${host}`,
      "-keyout",
      privateKey,
      "-out",
      certificate,
    ],
    { stdio: "ignore" },
  );
  if (cert.status !== 0) throw new Error("Could not create the temporary loopback TLS certificate");

  origin = createApiServer(
    () => ({
      fetch(request) {
        if (new URL(request.url).pathname === "/smoke-ready") return new Response("ready");
        if (new URL(request.url).pathname !== "/openai/v1/responses")
          return new Response(null, { status: 404 });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("data: first\n\n"));
              void finalGate.then(() => {
                controller.enqueue(encoder.encode("data: final\n\n"));
                controller.close();
              });
            },
          }),
          { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } },
        );
      },
    }),
    await freePort(),
    loopback,
  );

  const route = await readFile("deploy/traefik-api.yaml", "utf8");
  const privacy = (await readFile("deploy/traefik-privacy-args.txt", "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const flag of [
    "--accesslog=false",
    "--log.level=ERROR",
    "--log.filepath=/dev/null",
    "--global.sendanonymoususage=false",
  ])
    if (!privacy.includes(flag)) throw new Error(`Missing required privacy flag: ${flag}`);
  const productionURL = "http://zephium-backend:3000";
  if (
    route.split(productionURL).length !== 2 ||
    !route.includes('flushInterval: "-1ms"') ||
    !route.includes('responseHeaderTimeout: "330s"') ||
    !route.includes(`Host(\`${host}\`)`)
  ) {
    throw new Error("Unexpected Traefik API route configuration");
  }
  const dynamic = join(temporary, "api.yaml");
  await writeFile(
    dynamic,
    `${route.replace(productionURL, `http://${loopback}:${origin.port}`)}\ntls:\n  certificates:\n    - certFile: ${JSON.stringify(certificate)}\n      keyFile: ${JSON.stringify(privateKey)}\n`,
    { mode: 0o600 },
  );
  const proxyPort = await freePort();
  const traefik = process.env.TRAEFIK || resolve(".local/tools/bin/traefik");
  proxy = spawn(
    traefik,
    [
      ...privacy,
      `--entrypoints.websecure.address=${loopback}:${proxyPort}`,
      `--providers.file.filename=${dynamic}`,
      "--providers.file.watch=false",
      "--api=false",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  proxyExited = new Promise((done) => proxy?.once("exit", (code) => done(code)));
  for (const stream of [proxy.stdout, proxy.stderr])
    stream?.on("data", (bytes: Buffer) => {
      proxyOutput += bytes.toString().slice(0, 16_384);
    });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (proxy.exitCode !== null) throw new Error("Traefik exited before becoming ready");
    try {
      const response = await https(proxyPort, "/smoke-ready");
      let body = "";
      for await (const chunk of response) body += chunk.toString();
      if (response.statusCode === 200 && body === "ready") {
        ready = true;
        break;
      }
    } catch {
      /* Local listener is still starting. */
    }
    await Bun.sleep(50);
  }
  if (!ready) throw new Error("Traefik did not route the local readiness request");

  const canary = crypto.randomUUID();
  const response = await https(proxyPort, `/openai/v1/responses?probe=${canary}`, "POST", canary);
  if (response.statusCode !== 200)
    throw new Error(`Unexpected proxy status ${response.statusCode}`);
  for (const header of [
    "set-cookie",
    "content-encoding",
    "location",
    "www-authenticate",
    "proxy-authenticate",
    "x-request-id",
    "x-trace-id",
  ])
    if (response.headers[header] !== undefined)
      throw new Error(`Unexpected proxy response header: ${header}`);
  if (!String(response.headers["content-type"]).startsWith("text/event-stream"))
    throw new Error("Proxy changed the SSE content type");
  const watchdog = setTimeout(
    () => response.destroy(new Error("Local SSE stream stalled")),
    10_000,
  );
  let bytes = "";
  try {
    const chunks = response[Symbol.asyncIterator]();
    while (!bytes.includes("data: first\n\n")) {
      const part = await chunks.next();
      if (part.done) throw new Error("Proxy ended SSE before the first chunk");
      bytes += part.value.toString();
    }
    if (finalReleased || bytes.includes("data: final\n\n"))
      throw new Error("Final SSE data arrived before producer release");
    finalReleased = true;
    releaseFinal();
    for await (const part of { [Symbol.asyncIterator]: () => chunks }) bytes += part.toString();
  } finally {
    clearTimeout(watchdog);
  }
  if (bytes !== "data: first\n\ndata: final\n\n") throw new Error("Proxy changed the SSE bytes");
  if (proxyOutput.includes(canary)) throw new Error("Proxy output included a request identifier");
  process.stdout.write("Traefik loopback TLS/SSE privacy smoke passed\n");
} finally {
  releaseFinal();
  if (proxy && proxy.exitCode === null) proxy.kill("SIGTERM");
  if (proxyExited) await proxyExited;
  if (origin) await origin.stop(true);
  await rm(temporary, { recursive: true, force: true });
}
