#!/usr/bin/env node
import { hostname } from "node:os";
import { findFirstActivePort } from "../dist/server/discover.js";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function replaceTargetHostPort(browserWsUrl, host, port) {
  const url = new URL(browserWsUrl);
  url.hostname = host;
  url.port = String(port);
  return url.toString();
}

function buildOutput(endpoint) {
  const remotePort = endpoint.port;
  const connectHost = hostname();
  const localPort = remotePort === 9222 ? 9223 : remotePort;
  const remotePath = new URL(endpoint.browserWsUrl).pathname;
  const remoteTarget = replaceTargetHostPort(endpoint.browserWsUrl, connectHost, remotePort);
  const tunnelTarget = `ws://127.0.0.1:${localPort}${remotePath}`;

  return {
    remotePort,
    remotePath,
    profileDir: endpoint.profileDir,
    directTarget: remoteTarget,
    tunnelTarget,
    directCommand: `npm start -- --target ${shellQuote(remoteTarget)}`,
    sshTunnelCommand: `ssh -N -L ${localPort}:127.0.0.1:${remotePort} ${shellQuote(connectHost)}`,
    tunnelCommand: `npm start -- --target ${shellQuote(tunnelTarget)}`,
  };
}

function printHuman(out) {
  console.log(`Chrome CDP target found:
  profile: ${out.profileDir}
  remote:  127.0.0.1:${out.remotePort}${out.remotePath}

Direct connection:
  ${out.directCommand}

Remote connection:
  ${out.sshTunnelCommand} # create ssh tunnel
  ${out.tunnelCommand}
`);
}

try {
  if (process.argv.length > 2) {
    throw new Error("find-chrome does not accept arguments");
  }
  const endpoint = await findFirstActivePort();

  if (!endpoint) {
    console.error("No Chrome DevToolsActivePort file found.");
    console.error("Open chrome://inspect/#remote-debugging and allow remote debugging.");
    process.exit(1);
  }

  printHuman(buildOutput(endpoint));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
