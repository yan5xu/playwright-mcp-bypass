import { test, expect } from '@playwright/test';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import getPort from 'get-port'; // Utility to find an available port

// Helper function to start the server with --http-port
async function startServer(): Promise<{ serverProcess: ChildProcessWithoutNullStreams, port: number, url: string }> {
  const port = await getPort();
  const url = `http://localhost:${port}`;
  console.log(`Starting HTTP API server on port ${port}...`);

  // Use node directly to run the compiled cli.js
  const serverProcess = spawn('node', ['cli.js', '--http-port', String(port)], {
    stdio: ['pipe', 'pipe', 'pipe'], // Pipe all streams to satisfy ChildProcessWithoutNullStreams type
    detached: true, // Allows killing the process group
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (data) => {
    stderrOutput += data.toString();
    console.error(`[Server STDERR]: ${data}`);
  });

  // Wait for the server to log the listening message or exit
  await new Promise<void>((resolve, reject) => {
    const handleData = (data: Buffer) => {
      const output = data.toString();
      console.log(`[Server STDOUT]: ${output}`);
      if (output.includes(`HTTP API server listening on port ${port}`)) {
        serverProcess.stdout.removeListener('data', handleData); // Clean up listener
        serverProcess.stderr.removeListener('data', handleData);
        resolve();
      }
    };

    const handleExit = (code: number | null) => {
      reject(new Error(`Server process exited prematurely with code ${code}. Stderr: ${stderrOutput}`));
    };

    serverProcess.stdout.on('data', handleData);
    serverProcess.stderr.on('data', handleData); // Also listen on stderr for potential errors during startup
    serverProcess.once('exit', handleExit);

    // Timeout for server start
    setTimeout(() => {
      serverProcess.stdout.removeListener('data', handleData);
      serverProcess.stderr.removeListener('data', handleData);
      serverProcess.removeListener('exit', handleExit);
      reject(new Error(`Server failed to start within timeout. Stderr: ${stderrOutput}`));
    }, 15000); // 15 seconds timeout
  });

  console.log(`Server started successfully on ${url}`);
  return { serverProcess, port, url };
}

// Test suite for HTTP API
test.describe('HTTP API', () => {
  let serverProcess: ChildProcessWithoutNullStreams;
  let serverUrl: string;

  // Start server before all tests in this suite
  test.beforeAll(async () => {
    const { serverProcess: proc, url } = await startServer();
    serverProcess = proc;
    serverUrl = url;
  });

  // Stop server after all tests in this suite
  test.afterAll(async () => {
    console.log('Stopping HTTP API server...');
    if (serverProcess && !serverProcess.killed) {
      // Kill the process group to ensure child processes are also terminated
      process.kill(-serverProcess.pid!, 'SIGINT');
      await new Promise<void>(resolve => serverProcess.once('close', resolve));
      console.log('Server stopped.');
    }
  });

  // Test case 1: Basic GET request for browser_tab_list
  test('should handle GET /tools/browser_tab_list', async () => {
    const response = await fetch(`${serverUrl}/tools/browser_tab_list`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.result).toBeDefined();
    // Since it's a fresh server, expect "No tabs open" or an initial about:blank tab
    expect(body.result.content[0].type).toBe('text');
    // The exact text might vary slightly, check for key parts
    expect(body.result.content[0].text).toContain('tabs');
  });

  // Test case 2: Basic POST request for browser_navigate
  test('should handle POST /tools/browser_navigate', async () => {
    const sessionId = 'test-nav-session';
    const targetUrl = 'https://example.com';

    const response = await fetch(`${serverUrl}/tools/browser_navigate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Session-Id': sessionId,
      },
      body: JSON.stringify({ url: targetUrl }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.result).toBeDefined();
    expect(body.result.content[0].type).toBe('text');
    expect(body.result.content[0].text).toContain(`Navigated to ${targetUrl}`);
    expect(body.result.content[0].text).toContain('Example Domain'); // Check for page title/content
  });

   // Test case 3: POST request with session reuse
   test('should reuse session for subsequent POST requests', async () => {
    const sessionId = 'test-reuse-session';
    const url1 = 'https://example.com';
    const url2 = 'about:blank';

    // First request (creates session)
    await fetch(`${serverUrl}/tools/browser_navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Session-Id': sessionId },
      body: JSON.stringify({ url: url1 }),
    });

    // Second request (reuses session)
    const response = await fetch(`${serverUrl}/tools/browser_navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Session-Id': sessionId },
      body: JSON.stringify({ url: url2 }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.result.content[0].text).toContain(`Navigated to ${url2}`);
    // Check that it's not the previous page's content
    expect(body.result.content[0].text).not.toContain('Example Domain');
  });

  // Test case 4: Error handling for non-existent tool
  test('should return error for non-existent tool', async () => {
    const response = await fetch(`${serverUrl}/tools/invalid_tool_name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(500); // Or 404 if we implement specific check
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Tool "invalid_tool_name" not found');
  });

  // Test case 5: Error handling for missing required parameter
  test('should return error for missing required parameter', async () => {
    const response = await fetch(`${serverUrl}/tools/browser_navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}), // Missing 'url'
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Required'); // Check for Zod validation error message
    // Make the check less sensitive to whitespace around brackets/colons
    expect(body.error).toContain('"path":');
    expect(body.error).toContain('"url"');
  });

  // Add more tests here for:
  // - Different tools (click, type, snapshot)
  // - Different sessions interacting concurrently (might be harder to test reliably)
  // - GET /tools/browser_tab_list with specific session
  // - Error cases (invalid ref, etc.)

});