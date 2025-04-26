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

import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import http from 'http';
import type { ServerList } from './server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js'; // Import ToolSchema type

export async function startHttpServer(port: number, serverList: ServerList) {
  // Session management
  const sessions = new Map<string, Server>();
  const sessionTimers = new Map<string, NodeJS.Timeout>(); // For session timeout
  const sessionTimeout = 30 * 60 * 1000; // 30 minutes (in milliseconds)

  const app = new Koa();
  const router = new Router();

  // Middleware
  app.use(cors({
    allowHeaders: ['Content-Type', 'Session-Id'], // Allow Session-Id header
    exposeHeaders: [], // Adjust as needed
  }));
  app.use(bodyParser());

  // Session handling middleware
  app.use(async (ctx, next) => {
    const sessionId = ctx.get('session-id') || 'default'; // Get session ID from header or use 'default'
    let server = sessions.get(sessionId);

    if (!server) {
      console.log(`[HTTP Server] Creating new session: ${sessionId}`);
      // Pass the sessionId to create() so the factory can generate a unique user data dir
      server = await serverList.create(sessionId);
      sessions.set(sessionId, server);
    } else {
      console.log(`[HTTP Server] Reusing session: ${sessionId}`);
    }

    // Reset session timeout on activity
    if (sessionTimers.has(sessionId)) {
      clearTimeout(sessionTimers.get(sessionId)!);
    }
    const timer = setTimeout(async () => {
      console.log(`[HTTP Server] Session timed out: ${sessionId}`);
      const serverToClose = sessions.get(sessionId);
      if (serverToClose) {
        await serverList.close(serverToClose); // Use serverList to close
        sessions.delete(sessionId);
      }
      sessionTimers.delete(sessionId);
    }, sessionTimeout);
    sessionTimers.set(sessionId, timer);

    // Pass the server instance and sessionId to the route handlers via context state
    ctx.state.server = server;
    ctx.state.sessionId = sessionId;

    await next(); // Proceed to the next middleware (router)
  });

  // Tool calling route
  router.post('/tools/:toolName', async (ctx) => {
    const { toolName } = ctx.params;
    const params = ctx.request.body || {}; // Get params from request body
    const server: Server = ctx.state.server; // Get Server instance from session middleware
    const sessionId: string = ctx.state.sessionId; // Get sessionId for logging

    try {
      // Optional: Check if the tool exists before calling
      // Note: server.listTools() might not be available directly on the SDK's Server type.
      // If needed, we might need to adjust how tools are accessed or skip this check.
      // For now, we'll rely on callTool to handle non-existent tools.

      console.log(`[HTTP Server] Calling tool "${toolName}" for session ${sessionId} with params:`, params);
      // Use the callTool method we added to the Server prototype
      const result = await (server as any).callTool(toolName, params);

      ctx.status = 200; // OK
      ctx.body = { success: true, result }; // Return success and result
    } catch (error: any) {
      console.error(`[HTTP Server] Error calling tool "${toolName}" for session ${sessionId}:`, error);
      ctx.status = 500; // Internal Server Error (or potentially 400/404 depending on error type)
      // Respond with error details
      ctx.body = { success: false, error: String(error.message || error) };
    }
  });

  // Specific route for GET /tools/browser_tab_list
  router.get('/tools/browser_tab_list', async (ctx) => {
    const server: Server = ctx.state.server;
    const sessionId: string = ctx.state.sessionId;
    const toolName = 'browser_tab_list';

    try {
      console.log(`[HTTP Server] Calling tool "${toolName}" for session ${sessionId}`);
      const result = await (server as any).callTool(toolName, {}); // No parameters needed
      ctx.status = 200;
      ctx.body = { success: true, result };
    } catch (error: any) {
      console.error(`[HTTP Server] Error calling tool "${toolName}" for session ${sessionId}:`, error);
      ctx.status = 500;
      ctx.body = { success: false, error: String(error.message || error) };
    }
  });

  // Route to generate OpenAPI specification
  router.get('/openapi.json', async (ctx) => {
    try {
      // Get a server instance (use default session, create if needed)
      // We need to ensure a server instance exists to list tools.
      // The session middleware already handles this, so ctx.state.server should be valid.
      const server: Server = ctx.state.server;
      const serverUrl = `http://localhost:${port}`; // Assuming localhost for spec

      // Get the registered tools from the server instance property we added
      const registeredTools = (server as any)._registeredTools || [];
      const toolSchemas = registeredTools.map((tool: any) => tool.schema);

      // Basic OpenAPI structure (without components)
      const openApiSpec: any = {
        openapi: '3.1.0',
        info: {
          title: 'Playwright MCP HTTP API',
          version: require('../package.json').version,
          description: 'HTTP API for interacting with the Playwright MCP server.',
        },
        servers: [
          { url: serverUrl, description: 'Local development server' }
        ],
        paths: {}, // Paths will be populated below
      };

      // Add paths for each tool
      for (const tool of toolSchemas) {
        const path = `/tools/${tool.name}`;
        const isGetOperation = tool.name === 'browser_tab_list'; // Special case for GET
        const method = isGetOperation ? 'get' : 'post';

        openApiSpec.paths[path] = {
          [method]: {
            tags: ['Tools'],
            summary: tool.description || `Execute ${tool.name}`,
            operationId: tool.name,
            parameters: [
              // Inline Session-Id parameter definition
              {
                name: 'Session-Id',
                in: 'header',
                required: false,
                description: 'Optional session identifier. If not provided, uses the "default" session.',
                schema: { type: 'string' }
              }
            ],
            responses: {
              '200': {
                description: 'Successful operation',
                content: {
                  'application/json': {
                    // Inline SuccessResponse schema definition
                    schema: {
                      type: 'object',
                      properties: {
                        success: { type: 'boolean', example: true },
                        result: { type: 'object', description: 'Result from the tool execution' }
                      }
                    }
                  }
                }
              },
              '500': {
                description: 'Internal server error or tool execution error',
                content: {
                  'application/json': {
                    // Inline ErrorResponse schema definition
                    schema: {
                      type: 'object',
                      properties: {
                        success: { type: 'boolean', example: false },
                        error: { type: 'string', description: 'Error message' }
                      }
                    }
                  }
                }
              }
            }
          }
        };

        // Add requestBody for POST operations only if inputSchema exists and has properties or is required
        if (!isGetOperation && tool.inputSchema) {
          const inputSchema = tool.inputSchema as any; // Cast to any to access properties easily
          const hasProperties = inputSchema.properties && Object.keys(inputSchema.properties).length > 0;
          const isRequired = inputSchema.required && inputSchema.required.length > 0;

          if (hasProperties || isRequired) {
            // Clone the schema and remove the $schema property
            const schemaForRequestBody = { ...inputSchema };
            delete schemaForRequestBody.$schema; // Remove $schema

            openApiSpec.paths[path][method].requestBody = {
              description: 'Parameters for the tool',
              // Set required based on whether the schema has any required properties
              required: isRequired,
              content: {
                'application/json': {
                  schema: schemaForRequestBody // Use the cleaned schema
                }
              }
            };
          }
          // If no properties and not required, omit requestBody entirely
        }
      }

      ctx.status = 200;
      ctx.type = 'application/json';
      ctx.body = openApiSpec;

    } catch (error: any) {
      console.error('[HTTP Server] Error generating OpenAPI spec:', error);
      ctx.status = 500;
      ctx.body = { success: false, error: `Failed to generate OpenAPI spec: ${error.message}` };
    }
  });


  // Apply routes
  app.use(router.routes()).use(router.allowedMethods());

  // Create and start the HTTP server
  const httpServer = http.createServer(app.callback());

  httpServer.listen(port, () => {
    console.log(`[HTTP Server] HTTP API server listening on port ${port}`);
  });

  // Graceful shutdown handling
  const gracefulShutdown = async () => {
    console.log('[HTTP Server] Closing HTTP server...');
    httpServer.close(async (err) => {
      if (err) {
        console.error('[HTTP Server] Error closing HTTP server:', err);
      } else {
        console.log('[HTTP Server] HTTP server closed.');
      }

      // Clean up all sessions
      console.log('[HTTP Server] Closing all browser sessions...');
      const closingPromises: Promise<void>[] = [];
      for (const [sessionId, server] of sessions.entries()) {
        console.log(`[HTTP Server] Closing session: ${sessionId}`);
        closingPromises.push(serverList.close(server)); // Use serverList to close
        // Clear associated timer
        if (sessionTimers.has(sessionId)) {
          clearTimeout(sessionTimers.get(sessionId)!);
          sessionTimers.delete(sessionId);
        }
      }
      sessions.clear(); // Clear the sessions map

      try {
        await Promise.all(closingPromises);
        console.log('[HTTP Server] All sessions closed.');
      } catch (closeError) {
        console.error('[HTTP Server] Error closing sessions:', closeError);
      } finally {
        process.exit(err ? 1 : 0); // Exit with appropriate code
      }
    });

    // Force close after a timeout if graceful shutdown fails
    setTimeout(() => {
      console.error('[HTTP Server] Graceful shutdown timed out. Forcing exit.');
      process.exit(1);
    }, 15000); // 15 seconds timeout
  };

  // Listen for termination signals
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}