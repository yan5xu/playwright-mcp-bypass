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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { Context } from './context';

import type { Tool } from './tools/tool';
import type { Resource } from './resources/resource';
import type { ContextOptions } from './context';

type Options = ContextOptions & {
  name: string;
  version: string;
  tools: Tool[];
  resources: Resource[],
};

export function createServerWithTools(options: Options): Server {
  const { name, version, tools, resources } = options;
  const context = new Context(options);
  const server = new Server({ name, version }, {
    capabilities: {
      tools: {},
      resources: {},
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: tools.map(tool => tool.schema) };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: resources.map(resource => resource.schema) };
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = tools.find(tool => tool.schema.name === request.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Tool "${request.params.name}" not found` }],
        isError: true,
      };
    }

    try {
      const result = await tool.handle(context, request.params.arguments);
      return result;
    } catch (error) {
      return {
        content: [{ type: 'text', text: String(error) }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const resource = resources.find(resource => resource.schema.uri === request.params.uri);
    if (!resource)
      return { contents: [] };

    const contents = await resource.read(context, request.params.uri);
    return { contents };
  });

  const oldClose = server.close.bind(server);

  server.close = async () => {
    await oldClose();
    await context.close();
  };

  // Add the callTool method directly to the server instance
  (server as any).callTool = async (name: string, args: any) => {
    // Find the registered handler for CallToolRequestSchema
    // This relies on the internal structure of the SDK's Server class,
    // specifically how request handlers are stored. This might be fragile.
    // A potentially safer approach would be to directly invoke the logic
    // defined in the setRequestHandler call above.

    // Let's try invoking the logic directly:
    const tool = tools.find(tool => tool.schema.name === name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }

    try {
      // Simulate the result structure expected by the HTTP handler
      const result = await tool.handle(context, args);
      // Assuming tool.handle returns the direct result or throws an error
      // We need to check the structure of 'result' if it matches MCP response format
      if (result && (result as any).isError) {
         // Attempt to extract a meaningful error message
         const errorContent = (result as any).content?.find((c: any) => c.type === 'text')?.text;
         throw new Error(errorContent || `Tool "${name}" execution failed`);
      }
      return result; // Return the direct result
    } catch (error: any) {
      // Re-throw the error to be caught by the HTTP handler
      throw new Error(String(error.message || error));
    }
  };

  // Attach the actual tools array to the server instance for later retrieval
  (server as any)._registeredTools = tools;

  return server;
}

export class ServerList {
  private _servers: Server[] = [];
  // Update factory function type to accept optional sessionId and return a Promise
  private _serverFactory: (sessionId?: string) => Promise<Server>;

  constructor(serverFactory: (sessionId?: string) => Promise<Server>) {
    this._serverFactory = serverFactory;
  }

  // Update create method to accept optional sessionId
  async create(sessionId?: string) {
    // Call the factory with the sessionId
    const server = await this._serverFactory(sessionId);
    this._servers.push(server);
    return server;
  }

  async close(server: Server) {
    const index = this._servers.indexOf(server);
    if (index !== -1)
      this._servers.splice(index, 1);
    await server.close();
  }

  async closeAll() {
    await Promise.all(this._servers.map(server => server.close()));
  }
}
