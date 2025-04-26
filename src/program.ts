/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { program } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';


import { createServer } from './index';
import { ServerList } from './server';
import { startHttpServer } from './httpServer'; // Import the new function

import type { LaunchOptions } from 'playwright';
import assert from 'assert';
import { ToolCapability } from './tools/tool';

const packageJSON = require('../package.json');

program
    .version('Version ' + packageJSON.version)
    .name(packageJSON.name)
    .option('--browser <browser>', 'Browser or chrome channel to use, possible values: chrome, firefox, webkit, msedge.')
    .option('--caps <caps>', 'Comma-separated list of capabilities to enable, possible values: tabs, pdf, history, wait, files, install. Default is all.')
    .option('--cdp-endpoint <endpoint>', 'CDP endpoint to connect to.')
    .option('--executable-path <path>', 'Path to the browser executable.')
    .option('--headless', 'Run browser in headless mode, headed by default')
    .option('--port <port>', 'Port to listen on for SSE transport.')
    .option('--user-data-dir <path>', 'Path to the user data directory')
    .option('--vision', 'Run server that uses screenshots (Aria snapshots are used by default)')
    .option('--http-port <port>', 'Port to listen on for HTTP API.') // Add the new option
    .action(async options => {
      let browserName: 'chromium' | 'firefox' | 'webkit';
      let channel: string | undefined;
      switch (options.browser) {
        case 'chrome':
        case 'chrome-beta':
        case 'chrome-canary':
        case 'chrome-dev':
        case 'msedge':
        case 'msedge-beta':
        case 'msedge-canary':
        case 'msedge-dev':
          browserName = 'chromium';
          channel = options.browser;
          break;
        case 'chromium':
          browserName = 'chromium';
          break;
        case 'firefox':
          browserName = 'firefox';
          break;
        case 'webkit':
          browserName = 'webkit';
          break;
        default:
          browserName = 'chromium';
          channel = 'chrome';
      }

      const launchOptions: LaunchOptions = {
        headless: !!options.headless,
        channel,
        executablePath: options.executablePath,
      };

      // Define the server factory function that now accepts an optional sessionId
      const serverFactory = async (sessionId?: string) => {
        // Determine the user data directory:
        // 1. Use the one provided via CLI if available.
        // 2. Otherwise, create a session-specific one.
        // Note: If a CLI path is provided, all sessions will share it, potentially causing conflicts.
        const effectiveUserDataDir = options.userDataDir ?? await createUserDataDir(browserName, sessionId);

        return createServer({
          browserName,
          userDataDir: effectiveUserDataDir, // Use the determined directory
          launchOptions,
        vision: !!options.vision,
          cdpEndpoint: options.cdpEndpoint,
          capabilities: options.caps?.split(',').map((c: string) => c.trim() as ToolCapability),
        });
      };

      // Pass the factory function to ServerList
      const serverList = new ServerList(serverFactory);
      setupExitWatchdog(serverList);

      if (options.httpPort) { // Check for httpPort first
        startHttpServer(+options.httpPort, serverList);
      } else if (options.port) { // Then check for port (SSE)
        startSSEServer(+options.port, serverList);
      } else { // Default to Stdio (doesn't support multiple sessions, uses default profile)
        const server = await serverList.create(); // Create without sessionId for stdio
        await server.connect(new StdioServerTransport());
      }
    });

function setupExitWatchdog(serverList: ServerList) {
  const handleExit = async () => {
    setTimeout(() => process.exit(0), 15000);
    await serverList.closeAll();
    process.exit(0);
  };

  process.stdin.on('close', handleExit);
  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);
}

program.parse(process.argv);

// Modified to accept an optional sessionId
async function createUserDataDir(browserName: 'chromium' | 'firefox' | 'webkit', sessionId?: string) {
  let cacheDirectory: string;
  if (process.platform === 'linux')
    cacheDirectory = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  else if (process.platform === 'darwin')
    cacheDirectory = path.join(os.homedir(), 'Library', 'Caches');
  else if (process.platform === 'win32')
    cacheDirectory = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  else
    throw new Error('Unsupported platform: ' + process.platform);

  // Append sessionId if provided and not empty/default, otherwise use the default profile name
  const profileSuffix = sessionId && sessionId !== 'default' ? `-${sessionId}` : '';
  const profileDirName = `mcp-${browserName}-profile${profileSuffix}`;

  const result = path.join(cacheDirectory, 'ms-playwright', profileDirName);
  await fs.promises.mkdir(result, { recursive: true });
  return result;
}

async function startSSEServer(port: number, serverList: ServerList) {
  const sessions = new Map<string, SSEServerTransport>();
  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      const searchParams = new URL(`http://localhost${req.url}`).searchParams;
      const sessionId = searchParams.get('sessionId');
      if (!sessionId) {
        res.statusCode = 400;
        res.end('Missing sessionId');
        return;
      }
      const transport = sessions.get(sessionId);
      if (!transport) {
        res.statusCode = 404;
        res.end('Session not found');
        return;
      }

      await transport.handlePostMessage(req, res);
      return;
    } else if (req.method === 'GET') {
      const transport = new SSEServerTransport('/sse', res);
      const sessionId = transport.sessionId; // Get sessionId from transport
      sessions.set(sessionId, transport);
      // Pass sessionId when creating server for SSE
      const server = await serverList.create(sessionId);
      res.on('close', () => {
        sessions.delete(sessionId);
        serverList.close(server).catch(e => console.error(e));
      });
      await server.connect(transport);
      return;
    } else {
      res.statusCode = 405;
      res.end('Method not allowed');
    }
  });

  httpServer.listen(port, () => {
    const address = httpServer.address();
    assert(address, 'Could not bind server socket');
    let url: string;
    if (typeof address === 'string') {
      url = address;
    } else {
      const resolvedPort = address.port;
      let resolvedHost = address.family === 'IPv4' ? address.address : `[${address.address}]`;
      if (resolvedHost === '0.0.0.0' || resolvedHost === '[::]')
        resolvedHost = 'localhost';
      url = `http://${resolvedHost}:${resolvedPort}`;
    }
    console.log(`Listening on ${url}`);
    console.log('Put this in your client config:');
    console.log(JSON.stringify({
      'mcpServers': {
        'playwright': {
          'url': `${url}/sse`
        }
      }
    }, undefined, 2));
  });
}
