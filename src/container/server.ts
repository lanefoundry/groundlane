import { pathToFileURL } from "node:url";

import type { Server } from "node:http";

import { createGroundlaneServices } from "../composition.js";
import { parseConfig } from "../config.js";
import { createContainerApp } from "./app.js";

const DEFAULT_PORT = 8080;
const SHUTDOWN_GRACE_MS = 10_000;

export interface RunningContainerServer {
  server: Server;
  shutdown(signal: NodeJS.Signals): Promise<void>;
}

export interface StartContainerOptions {
  /** When provided, the container wires this Analytics Engine writer into
   *  the toolError sink. Omit on platforms without Analytics Engine. */
  errorLogWriter?: {
    writeDataPoint(event: { blobs?: readonly string[]; doubles?: readonly number[]; indexes?: readonly string[] }): void;
  };
}

export function startContainerServer(
  port: number = Number(process.env.PORT ?? DEFAULT_PORT),
  options: StartContainerOptions = {},
): RunningContainerServer {
  const config = parseConfig(process.env);
  const services = createGroundlaneServices(config);
  const app = createContainerApp({
    authToken: config.authToken,
    registryFactory: services.registryFactory,
    ...(options.errorLogWriter === undefined ? {} : { errorLogWriter: options.errorLogWriter }),
  });
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(
      JSON.stringify({
        level: "info",
        event: "server_started",
        port,
      }),
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(
      JSON.stringify({ level: "info", event: "server_stopping", signal }),
    );

    const forceClose = setTimeout(() => {
      server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    forceClose.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } finally {
      clearTimeout(forceClose);
      await services.close();
    }
  };

  return { server, shutdown };
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  const running = startContainerServer();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void running
        .shutdown(signal)
        .then(() => {
          process.exitCode = 0;
        })
        .catch(() => {
          process.exitCode = 1;
        });
    });
  }
}