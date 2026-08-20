import http, { type IncomingHttpHeaders } from "node:http";
import net, { type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { resolvePublicUrl, type DnsLookup, type ResolvedAddress } from "../../core/url-policy.js";

export interface SafeProxyOptions { lookup?: DnsLookup; socketTimeoutMs: number; maxResponseBytes: number; allowedPorts?: ReadonlySet<number> }
export interface SafeProxy { url: string; close(): Promise<void> }

export function parseConnectAuthority(authority: string): { hostname: string; port: number } {
  let url: URL;
  try { url = new URL(`https://${authority}`); } catch { throw new Error("invalid CONNECT target"); }
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CONNECT port");
  return { hostname: url.hostname, port };
}

export function sanitizeProxyHeaders(headers: IncomingHttpHeaders, host: string): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = { ...headers, host };
  delete result["proxy-authorization"]; delete result["proxy-connection"];
  return result;
}

function connectOne(addresses: readonly ResolvedAddress[], port: number, timeout: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let index = 0; let last: Error | undefined;
    const attempt = () => {
      const target = addresses[index++];
      if (!target) { reject(last ?? new Error("no validated address")); return; }
      const socket = net.connect({ host: target.address, family: target.family, port });
      let connected = false;
      socket.setTimeout(timeout);
      socket.once("connect", () => { connected = true; resolve(socket); });
      socket.once("timeout", () => socket.destroy(new Error("upstream timeout")));
      socket.once("error", (error) => { last = error; if (!connected) attempt(); });
    };
    attempt();
  });
}

export async function createSafeProxy(options: SafeProxyOptions): Promise<SafeProxy> {
  const sockets = new Set<Socket>();
  const policy = { ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.allowedPorts ? { allowedPorts: options.allowedPorts } : {}) };
  const server = http.createServer();
  server.on("request", (request, response) => { void (async () => {
    try {
      if (!request.url) throw new Error("missing target");
      const destination = await resolvePublicUrl(request.url, policy);
      if (destination.url.protocol !== "http:") throw new Error("HTTPS must use CONNECT");
      const upstream = http.request({ hostname: destination.addresses[0]?.address, family: destination.addresses[0]?.family, port: destination.port, method: request.method, path: `${destination.url.pathname}${destination.url.search}`, headers: sanitizeProxyHeaders(request.headers, destination.url.host), timeout: options.socketTimeoutMs });
      upstream.once("response", (incoming) => {
        const length = Number(incoming.headers["content-length"]);
        if (Number.isFinite(length) && length > options.maxResponseBytes) { incoming.destroy(); response.writeHead(413).end(); return; }
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > options.maxResponseBytes) { incoming.destroy(); response.destroy(); } });
        incoming.pipe(response);
      });
      upstream.once("timeout", () => upstream.destroy(new Error("upstream timeout")));
      upstream.once("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      response.once("close", () => upstream.destroy()); request.pipe(upstream);
    } catch { response.writeHead(403, { connection: "close", "content-type": "text/plain" }).end("Forbidden"); }
  })();
  });
  server.on("connect", (request, client, head) => { void (async () => {
    try {
      if (!request.url) throw new Error("missing target");
      const { hostname, port } = parseConnectAuthority(request.url);
      const destination = await resolvePublicUrl(`https://${hostname}:${port}`, policy);
      if (client.destroyed) return;
      const upstream = await connectOne(destination.addresses, port, options.socketTimeoutMs);
      sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream));
      let receivedBytes = 0;
      upstream.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > options.maxResponseBytes) { upstream.destroy(); client.destroy(); }
      });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream); client.once("close", () => upstream.destroy());
    } catch { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
  })();
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("proxy failed to bind");
  let closing: Promise<void> | undefined;
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { closing ??= new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }); await closing; } };
}
