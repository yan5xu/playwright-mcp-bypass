# Playwright MCP 改造计划

## 项目背景

Playwright MCP 是一个 Model Context Protocol (MCP) 服务器，提供基于 Playwright 的浏览器自动化能力。目前，该服务器支持两种通信方式：

1. **Stdio 传输**：通过标准输入/输出进行通信（默认模式）
2. **SSE 传输**：当使用 `--port` 参数时，启动一个基于 HTTP 的 Server-Sent Events (SSE) 服务

## 改造目标

本次改造的主要目标是：

1. **增加标准 HTTP API**：实现一个基于请求/响应模式的 HTTP API，允许客户端通过发送单个 HTTP 请求来执行 MCP 工具，并直接在 HTTP 响应中接收结果
2. **保持现有功能**：确保现有的 Stdio 和 SSE 传输方式继续正常工作

## 技术方案

### 1. 命令行参数

添加一个新的命令行参数 `--http-port <port>`，用于指定 HTTP API 的监听端口：

```
npx playwright-mcp-bypass@latest --http-port 8080
```

### 2. HTTP API 设计

#### 端点结构

- 基本路径：`/tools/{tool_name}`
- 例如：
  - `/tools/browser_navigate`
  - `/tools/browser_click`
  - `/tools/browser_type`

#### HTTP 方法

- 主要使用 `POST` 方法执行工具操作
- 可选：对于只读操作（如 `browser_tab_list`）可以支持 `GET` 方法

#### 请求格式

- Content-Type: `application/json`
- 请求体：包含工具所需的参数，格式为 JSON

示例（调用 `browser_navigate`）：
```json
{
  "url": "https://example.com"
}
```

示例（调用 `browser_click`）：
```json
{
  "element": "Login Button",
  "ref": "button#login"
}
```

#### 响应格式

- Content-Type: `application/json`
- 成功响应（HTTP 200）：
  ```json
  {
    "success": true,
    "result": { ... } // 工具执行结果
  }
  ```
- 错误响应（HTTP 4xx/5xx）：
  ```json
  {
    "success": false,
    "error": "错误信息"
  }
  ```

### 3. 实现步骤

#### 3.1 修改 `src/program.ts`

1. 添加新的命令行选项 `--http-port <port>`：
   ```typescript
   .option('--http-port <port>', 'Port to listen on for HTTP API.')
   ```

2. 引入 Koa.js 及相关中间件：
  ```typescript
  import Koa from 'koa';
  import Router from '@koa/router';
  import bodyParser from 'koa-bodyparser';
  import cors from '@koa/cors';
  import http from 'http'; // 仍然需要 http 来创建服务器实例
  ```

3. 创建新的函数 `startHttpServer`，使用 Koa.js：
  ```typescript
  async function startHttpServer(port: number, serverList: ServerList) {
    // 会话管理
    const sessions = new Map<string, Server>();
    const sessionTimers = new Map<string, NodeJS.Timeout>(); // 用于会话超时
    const sessionTimeout = 30 * 60 * 1000; // 30 分钟

    const app = new Koa();
    const router = new Router();

    // 中间件
    app.use(cors({
      allowHeaders: ['Content-Type', 'Session-Id'], // 允许 Session-Id 头
      exposeHeaders: [], // 根据需要暴露头
    }));
    app.use(bodyParser());

    // 会话处理中间件
    app.use(async (ctx, next) => {
      const sessionId = ctx.get('session-id') || 'default';
      let server = sessions.get(sessionId);

      if (!server) {
        console.log(`Creating new session: ${sessionId}`);
        server = await serverList.create();
        sessions.set(sessionId, server);
      } else {
        console.log(`Reusing session: ${sessionId}`);
      }

      // 更新会话超时
      if (sessionTimers.has(sessionId)) {
        clearTimeout(sessionTimers.get(sessionId)!);
      }
      const timer = setTimeout(async () => {
        console.log(`Session timed out: ${sessionId}`);
        const serverToClose = sessions.get(sessionId);
        if (serverToClose) {
          await serverList.close(serverToClose);
          sessions.delete(sessionId);
        }
        sessionTimers.delete(sessionId);
      }, sessionTimeout);
      sessionTimers.set(sessionId, timer);

      ctx.state.server = server; // 将 server 实例传递给后续中间件/路由
      ctx.state.sessionId = sessionId;
      await next();
    });

    // 路由定义
    router.post('/tools/:toolName', async (ctx) => {
      const { toolName } = ctx.params;
      const params = ctx.request.body || {};
      const server: Server = ctx.state.server;

      try {
        // 可选：检查工具是否存在
        const tools = await server.listTools();
        const toolExists = tools.tools.some(tool => tool.name === toolName);
        if (!toolExists) {
          ctx.status = 404;
          ctx.body = { success: false, error: `Tool "${toolName}" not found` };
          return;
        }

        console.log(`Calling tool "${toolName}" for session ${ctx.state.sessionId} with params:`, params);
        const result = await server.callTool(toolName, params);
        ctx.status = 200;
        ctx.body = { success: true, result };
      } catch (error: any) {
        console.error(`Error calling tool "${toolName}" for session ${ctx.state.sessionId}:`, error);
        ctx.status = 500;
        ctx.body = { success: false, error: String(error.message || error) };
      }
    });

    // 特殊处理 GET /tools/browser_tab_list
    router.get('/tools/browser_tab_list', async (ctx) => {
      const server: Server = ctx.state.server;
      try {
        console.log(`Calling tool "browser_tab_list" for session ${ctx.state.sessionId}`);
        const result = await server.callTool('browser_tab_list', {});
        ctx.status = 200;
        ctx.body = { success: true, result };
      } catch (error: any) {
        console.error(`Error calling tool "browser_tab_list" for session ${ctx.state.sessionId}:`, error);
        ctx.status = 500;
        ctx.body = { success: false, error: String(error.message || error) };
      }
    });

    app.use(router.routes()).use(router.allowedMethods());

    // 启动服务器
    const httpServer = http.createServer(app.callback());

    httpServer.listen(port, () => {
      console.log(`HTTP API server listening on port ${port}`);
    });

    // 添加优雅关闭处理
    process.on('SIGINT', async () => {
      console.log('Closing HTTP server...');
      httpServer.close();

      // 清理所有会话
      for (const [sessionId, server] of sessions.entries()) {
        console.log(`Closing session: ${sessionId}`);
        await serverList.close(server);
      }
      sessions.clear();

      // 清理所有定时器
      for (const timer of sessionTimers.values()) {
        clearTimeout(timer);
      }
      sessionTimers.clear();

      process.exit(0);
    });
  }
  ```

4. 在 `program.ts` 的 action 回调中添加对 `--http-port` 的处理：
   ```typescript
   if (options.httpPort) {
     startHttpServer(+options.httpPort, serverList);
   } else if (options.port) {
     startSSEServer(+options.port, serverList);
   } else {
     const server = await serverList.create();
     await server.connect(new StdioServerTransport());
   }
   ```

#### 3.2 实现 HTTP 请求处理 (使用 Koa.js)

在 `startHttpServer` 函数中，我们使用 Koa.js 及其路由和中间件来处理请求：

1. **Koa 实例创建**：`const app = new Koa();`
2. **中间件使用**：
  - `cors()`: 处理跨域请求。
  - `bodyParser()`: 解析 POST 请求的 JSON 或表单数据。
  - **自定义会话中间件**:
    - 从 `ctx.get('session-id')` 获取会话 ID。
    - 使用 `sessions` Map 获取或创建 `Server` 实例。
    - 更新会话超时定时器 (`sessionTimers`)。
    - 将 `server` 实例和 `sessionId` 存储在 `ctx.state` 中，以便后续路由访问。
3. **路由定义 (`@koa/router`)**：
  - `router.post('/tools/:toolName', ...)`: 处理工具调用请求。
    - 从 `ctx.params` 获取 `toolName`。
    - 从 `ctx.request.body` 获取参数。
    - 从 `ctx.state.server` 获取 `Server` 实例。
    - 调用 `server.callTool(toolName, params)`。
    - 根据结果设置 `ctx.status` 和 `ctx.body`。
  - `router.get('/tools/browser_tab_list', ...)`: 处理特定的 GET 请求。
4. **启动服务器**：
  - `const httpServer = http.createServer(app.callback());`
  - `httpServer.listen(port, ...)`

#### 3.3 错误处理

Koa 的错误处理通常通过 `try...catch` 块或专门的错误处理中间件完成。在我们的路由处理函数中：

1. 无效的 URL 路径：返回 404 Not Found
2. 无效的 JSON 格式：返回 400 Bad Request
3. 工具执行错误：返回 500 Internal Server Error
4. 不支持的 HTTP 方法：返回 405 Method Not Allowed

可以进一步增强错误处理：

```typescript
// 在 server.callTool 之前添加工具存在性检查
const tools = await server.listTools();
const toolExists = tools.tools.some(tool => tool.name === toolName);
if (!toolExists) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ success: false, error: `Tool "${toolName}" not found` }));
  return;
}
```

#### 3.4 会话管理 (使用 Koa 中间件)

我们使用一个自定义的 Koa 中间件来处理会话：

```typescript
// 在 startHttpServer 函数中
const sessions = new Map<string, Server>();
const sessionTimers = new Map<string, NodeJS.Timeout>();
const sessionTimeout = 30 * 60 * 1000; // 30 分钟

app.use(async (ctx, next) => {
 const sessionId = ctx.get('session-id') || 'default';
 let server = sessions.get(sessionId);

 if (!server) {
   console.log(`Creating new session: ${sessionId}`);
   server = await serverList.create();
   sessions.set(sessionId, server);
 } else {
   console.log(`Reusing session: ${sessionId}`);
 }

 // 更新会话超时
 if (sessionTimers.has(sessionId)) {
   clearTimeout(sessionTimers.get(sessionId)!);
 }
 const timer = setTimeout(async () => {
   console.log(`Session timed out: ${sessionId}`);
   const serverToClose = sessions.get(sessionId);
   if (serverToClose) {
     await serverList.close(serverToClose);
     sessions.delete(sessionId);
   }
   sessionTimers.delete(sessionId);
 }, sessionTimeout);
 sessionTimers.set(sessionId, timer);

 ctx.state.server = server; // 传递给后续处理
 ctx.state.sessionId = sessionId;
 await next(); // 调用下一个中间件或路由
});
```

优雅关闭处理（`process.on('SIGINT', ...)`）保持不变，确保在服务器停止时正确关闭所有浏览器实例和清理资源。

### 4. 依赖项

需要安装以下依赖项：

```bash
pnpm add koa @koa/router koa-bodyparser @koa/cors
# 同时需要安装它们的类型定义（如果使用 TypeScript）
pnpm add -D @types/koa @types/koa__router @types/koa-bodyparser @types/koa__cors
```

### 5. 文档更新

更新 `README.md`，添加以下内容：

1. 新的命令行参数 `--http-port` 的说明
2. HTTP API 的使用方法和示例
3. 会话管理的说明
4. 与现有 SSE 传输的区别

## 调用示例

### 使用 curl

```bash
# 导航到指定 URL
curl -X POST http://localhost:8080/tools/browser_navigate \
     -H "Content-Type: application/json" \
     -d '{
           "url": "https://example.com"
         }'

# 点击元素
curl -X POST http://localhost:8080/tools/browser_click \
     -H "Content-Type: application/json" \
     -d '{
           "element": "Login Button",
           "ref": "button#login"
         }'

# 在输入框中输入文本
curl -X POST http://localhost:8080/tools/browser_type \
     -H "Content-Type: application/json" \
     -d '{
           "element": "Username Input",
           "ref": "input#username",
           "text": "myUsername",
           "submit": false
         }'

# 获取标签列表
curl -X GET http://localhost:8080/tools/browser_tab_list
```

### 使用 JavaScript

```javascript
// 导航到指定 URL
fetch('http://localhost:8080/tools/browser_navigate', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    url: 'https://example.com'
  })
})
.then(response => response.json())
.then(data => console.log(data));
```

### 使用 Python

```python
import requests
import json

# 导航到指定 URL
response = requests.post(
    'http://localhost:8080/tools/browser_navigate',
    headers={'Content-Type': 'application/json'},
    data=json.dumps({'url': 'https://example.com'})
)
print(response.json())
```

## 技术架构图

```
+------------------+        HTTP Request        +-------------------------+
|                  |  ------------------------>  |                         |
|   HTTP Client    |                            |   Playwright MCP Server  |
|  (curl, script)  |  <------------------------  |   (with HTTP API)       |
|                  |        HTTP Response       |                         |
+------------------+                            +-------------------------+
                                                            |
                                                            | Controls
                                                            v
                                                +-------------------------+
                                                |                         |
                                                |   Browser Instance      |
                                                |   (Chrome, Firefox)     |
                                                |                         |
                                                +-------------------------+
```

## 技术实现细节 (Koa)

### Koa 中间件流程

1. **CORS 中间件**: 处理跨域请求头。
2. **Body Parser 中间件**: 解析请求体 (`ctx.request.body`)。
3. **会话管理中间件**:
  - 获取 `session-id`。
  - 获取或创建 `Server` 实例。
  - 更新会话超时。
  - 将 `server` 和 `sessionId` 存入 `ctx.state`。
  - 调用 `next()`。
4. **Router 中间件**:
  - 匹配路由 (`/tools/:toolName`)。
  - 执行对应的路由处理函数。
  - 路由处理函数从 `ctx.state` 获取 `server`，从 `ctx.params` 获取 `toolName`，从 `ctx.request.body` 获取参数。
  - 调用 `server.callTool()`。
  - 设置响应 `ctx.status` 和 `ctx.body`。

### Server 类扩展

为了支持 HTTP API，我们需要在 `Server` 类中添加一个便捷方法来调用工具（这部分与原计划相同）：

```typescript
// 在 src/server.ts 中扩展 Server 类
Server.prototype.callTool = async function(name: string, args: any) {
  const result = await this.handleRequest({
    jsonrpc: '2.0',
    id: String(Date.now()),
    method: 'callTool',
    params: {
      name,
      arguments: args
    }
  });
  
  if (result.error) {
    throw new Error(result.error.message);
  }
  
  return result.result;
};
```

### 工具调用流程

当通过 HTTP API 调用工具时，完整的流程如下：

1. 客户端发送 HTTP 请求到 `/tools/{tool_name}`
2. HTTP 服务器解析请求，提取工具名称和参数
3. 服务器根据会话 ID 获取或创建 `Server` 实例
4. 服务器调用 `server.callTool(toolName, params)`
5. `callTool` 方法创建一个 MCP 请求并调用 `server.handleRequest`
6. `handleRequest` 方法将请求分发给相应的请求处理程序（在这里是 `CallToolRequestSchema` 处理程序）
7. 请求处理程序查找匹配的工具并调用其 `handle` 方法
8. 工具的 `handle` 方法使用 `Context` 实例执行操作（如导航、点击等）
9. 结果返回给客户端

### 会话管理详解 (Koa 中间件)

会话管理通过自定义的 Koa 中间件实现：

1. **会话标识**：从请求头 `ctx.get('session-id')` 读取。
2. **会话存储**：使用 `sessions` Map。
3. **会话创建/复用**：在中间件中处理。
4. **会话超时**：使用 `sessionTimers` Map 和 `setTimeout` 实现。每次访问时重置定时器。
5. **会话传递**：通过 `ctx.state.server` 将 `Server` 实例传递给路由处理函数。
6. **会话清理**：通过 `process.on('SIGINT', ...)` 处理。

## 后续详细步骤及验证方法

### 阶段一：基础框架搭建与验证

1.  **安装依赖项**
   *   **操作**: 执行 `pnpm add koa @koa/router koa-bodyparser @koa/cors && pnpm add -D @types/koa @types/koa__router @types/koa-bodyparser @types/koa__cors`
   *   **验证**:
       *   检查 `package.json` 的 `dependencies` 和 `devDependencies` 是否包含新添加的包。
       *   检查 `pnpm-lock.yaml` 文件是否已更新。
       *   运行 `pnpm install` 确保没有报错。

2.  **修改 `src/program.ts`**
   *   **操作**:
       *   使用 `commander` 添加 `--http-port <port>` 选项。
       *   导入 `startHttpServer` 函数 (稍后创建)。
       *   在 `program.action` 的逻辑中，添加对 `options.httpPort` 的判断，如果存在则调用 `startHttpServer`。
   *   **验证**:
       *   运行 `node cli.js --help`，检查输出是否包含 `--http-port` 选项。
       *   (暂时无法完全验证，需等待 `startHttpServer` 实现) 尝试运行 `node cli.js --http-port 8080`，预期不应立即报错（可能因 `startHttpServer` 未定义而失败，这是正常的）。

3.  **创建并实现 `src/httpServer.ts` (基础结构)**
   *   **操作**:
       *   创建新文件 `src/httpServer.ts`。
       *   实现 `startHttpServer` 函数的基本框架：
           *   导入 `Koa`, `Router`, `bodyParser`, `cors`, `http`。
           *   创建 Koa 实例 (`app`) 和 Router 实例 (`router`)。
           *   使用 `cors()` 和 `bodyParser()` 中间件。
           *   添加一个临时的根路由 (`router.get('/', ctx => { ctx.body = 'OK'; })`) 用于测试。
           *   应用路由 (`app.use(router.routes()).use(router.allowedMethods())`)。
           *   创建 HTTP 服务器 (`http.createServer(app.callback())`)。
           *   启动服务器监听指定端口，并打印日志。
       *   在 `src/program.ts` 中正确导入 `startHttpServer`。
   *   **验证**:
       *   运行 `node cli.js --http-port 8080`。
       *   检查控制台是否输出 "HTTP API server listening on port 8080"。
       *   使用 `curl http://localhost:8080/`，预期收到 "OK"。
       *   使用 `curl -X OPTIONS http://localhost:8080/` -v，检查响应头是否包含正确的 CORS 头 (e.g., `Access-Control-Allow-Origin: *`)。
       *   使用 `curl -X POST http://localhost:8080/ -H "Content-Type: application/json" -d '{"test":1}'`，预期不会报错（即使路由不存在，body-parser 应该能处理）。

### 阶段二：核心功能实现与验证

4.  **扩展 `Server` 类添加 `callTool` 方法**
   *   **操作**:
       *   打开 `src/server.ts`。
       *   在 `Server` 类或其原型上添加 `async callTool(name: string, args: any)` 方法，实现如 `PLAN.md` 中所示的逻辑（构造 MCP 请求，调用 `handleRequest`，处理结果/错误）。
   *   **验证**:
       *   **单元测试**: 编写针对 `Server.prototype.callTool` 的单元测试。模拟 `handleRequest` 方法，测试 `callTool` 在不同输入（有效工具名/参数，无效工具名，`handleRequest` 返回错误等）下的行为。运行单元测试并确保通过。

5.  **实现会话管理中间件**
   *   **操作**:
       *   在 `src/httpServer.ts` 的 `startHttpServer` 函数中，在 `bodyParser` 之后、路由之前，添加会话管理中间件 (`app.use(async (ctx, next) => { ... })`)。
       *   实现中间件逻辑：获取 `session-id`，管理 `sessions` Map 和 `sessionTimers` Map，创建/复用 `Server` 实例，更新超时，将 `server` 和 `sessionId` 存入 `ctx.state`。
   *   **验证**:
       *   运行 `node cli.js --http-port 8080`。
       *   **首次请求**: 使用 `curl http://localhost:8080/` (或其他已定义的路由)，检查服务器日志是否输出 "Creating new session: default"。
       *   **带 ID 的首次请求**: 使用 `curl -H "Session-Id: test1234" http://localhost:8080/`，检查日志是否输出 "Creating new session: test1234"。
       *   **会话复用**: 再次发送相同 `Session-Id` 的请求 (`curl -H "Session-Id: test1234" http://localhost:8080/`)，检查日志是否输出 "Reusing session: test1234"。
       *   **会话超时**: (需要将 `sessionTimeout` 临时调小，例如 5 秒) 发送一个请求，等待超过超时时间，检查日志是否输出 "Session timed out: ..."。再次发送相同 `Session-Id` 的请求，检查日志是否输出 "Creating new session: ..."。

6.  **实现工具调用路由 (`POST /tools/:toolName`)**
   *   **操作**:
       *   在 `src/httpServer.ts` 中，移除临时根路由，添加 `router.post('/tools/:toolName', async (ctx) => { ... })`。
       *   实现路由处理逻辑：从 `ctx.params`, `ctx.request.body`, `ctx.state` 获取所需信息，调用 `ctx.state.server.callTool()`，处理成功/错误响应。
       *   (可选) 添加工具存在性检查。
   *   **验证**:
       *   运行 `node cli.js --http-port 8080`。
       *   **调用有效工具 (无参数)**: `curl -X POST http://localhost:8080/tools/browser_snapshot`，预期收到 `{"success":true, "result":{...}}` (具体 result 取决于 snapshot 内容)。
       *   **调用有效工具 (带参数)**: `curl -X POST -H "Content-Type: application/json" -d '{"url":"about:blank"}' http://localhost:8080/tools/browser_navigate`，预期收到 `{"success":true, "result":null}` 或类似成功响应。
       *   **调用无效工具**: `curl -X POST http://localhost:8080/tools/invalid_tool_name`，预期收到 `{"success":false, "error":"Tool \"invalid_tool_name\" not found"}` (如果做了检查) 或其他 500 错误。
       *   **调用带无效参数**: `curl -X POST -H "Content-Type: application/json" -d '{"invalid_param":"foo"}' http://localhost:8080/tools/browser_navigate`，预期收到 `{"success":false, "error":"..."}` (具体的错误信息取决于 Playwright 或工具本身的校验)。
       *   **使用会话**:
           *   `curl -H "Session-Id: nav-test" -X POST -H "Content-Type: application/json" -d '{"url":"https://example.com"}' http://localhost:8080/tools/browser_navigate`
           *   `curl -H "Session-Id: nav-test" -X POST http://localhost:8080/tools/browser_snapshot` (检查快照是否为 example.com)

7.  **实现特定路由 (`GET /tools/browser_tab_list`)**
   *   **操作**: 在 `src/httpServer.ts` 中添加 `router.get('/tools/browser_tab_list', async (ctx) => { ... })`。
   *   **验证**:
       *   运行 `node cli.js --http-port 8080`。
       *   `curl http://localhost:8080/tools/browser_tab_list`，预期收到 `{"success":true, "result":{ "tabs": [...] }}`。
       *   (可选) 使用 POST 调用 `browser_tab_new` 创建新标签页，然后再次 GET `browser_tab_list` 验证列表是否更新。

8.  **实现优雅关闭 (`SIGINT` 处理)**
   *   **操作**: 在 `src/httpServer.ts` 的 `startHttpServer` 中添加 `process.on('SIGINT', ...)` 逻辑，确保关闭 HTTP 服务器、清理所有会话和定时器。
   *   **验证**:
       *   运行 `node cli.js --http-port 8080`。
       *   创建几个会话 (使用不同 `Session-Id` 发送请求)。
       *   按 `Ctrl+C` 终止服务器。
       *   检查服务器日志是否输出 "Closing HTTP server..." 以及每个活动会话的 "Closing session: ..." 日志。
       *   检查进程是否正常退出 (退出码 0)。

### 阶段三：测试与文档

9.  **编写集成测试**
   *   **操作**:
       *   在 `tests/` 目录下创建新的测试文件，例如 `tests/httpApi.spec.ts`。
       *   使用测试框架 (如 Playwright Test 自带的) 和 HTTP 请求库 (如 `node-fetch` 或 `axios`) 编写测试用例。
       *   测试用例应覆盖：
           *   启动带 `--http-port` 的服务器。
           *   调用各种工具 (GET 和 POST)。
           *   验证成功和失败的响应。
           *   测试会话管理（使用不同 `Session-Id`）。
           *   测试错误处理 (无效工具、无效参数)。
   *   **验证**: 运行 `pnpm test` (或具体的测试命令)，确保所有 HTTP API 相关测试用例通过。

10. **更新文档 (`README.md`)**
   *   **操作**:
       *   添加关于 `--http-port` 命令行参数的说明。
       *   添加 HTTP API 的使用方法：端点、请求/响应格式、会话管理 (`Session-Id` 头)。
       *   提供 `curl`、JavaScript (`fetch`)、Python (`requests`) 的调用示例。
       *   说明与 SSE 传输的区别。
   *   **验证**: 人工审阅 `README.md`，确保信息准确、清晰、完整，示例可运行。

### 阶段四：发布

11. **准备发布**
   *   **操作**:
       *   确保所有代码已提交，并且所有测试通过。
       *   更新 `package.json` 中的 `version` 字段。
       *   (可选) 更新 `CHANGELOG.md`。
   *   **验证**:
       *   检查 `git status` 是否干净。
       *   确认 `pnpm test` 通过。
       *   检查 `package.json` 中的版本号。

12. **发布到 npm**
   *   **操作**: 运行 `pnpm publish` (可能需要先登录 npm)。
   *   **验证**: 在 npmjs.com 上检查新版本是否已发布成功。尝试使用 `npx playwright-mcp-bypass@<new_version> --http-port 8080` 运行新版本。
## 当前进度

**当前阶段**: 阶段一：基础框架搭建与验证
**当前步骤**: 1. 安装依赖项 (待开始)