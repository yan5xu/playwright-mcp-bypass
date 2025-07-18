## playwright-mcp-bypass

A Model Context Protocol (MCP) server that provides browser automation capabilities using [Playwright](https://playwright.dev), forked to enhance anti-bot detection bypass. This server enables LLMs to interact with web pages through structured accessibility snapshots.

### Key Features

- **Fast and lightweight**: Uses Playwright's accessibility tree, not pixel-based input.
- **LLM-friendly**: No vision models needed, operates purely on structured data.
- **Deterministic tool application**: Avoids ambiguity common with screenshot-based approaches.

### Project Information

This project (`playwright-mcp-bypass`) is maintained by [yan5xu](https://x.com/yan5xu) and is available at [yan5xu/playwright-mcp-bypass](https://github.com/yan5xu/playwright-mcp-bypass).

It originated as a fork of `microsoft/playwright-mcp` with the primary goal of enhancing the ability to bypass anti-bot detection mechanisms employed by some websites. This is achieved by adding the `--disable-blink-features=AutomationControlled` argument to the browser launch options, making the automated browser appear more like a regular user's browser.
### Use Cases

- Web navigation and form-filling
- Data extraction from structured content
- Automated testing driven by LLMs
- General-purpose browser interaction for agents

### Example config

```js
{
  "mcpServers": {
    "playwright-mcp-bypass": {
      "command": "npx",
      "args": [
        "playwright-mcp-bypass@latest"
      ]
    }
  }
}
```


#### Installation in VS Code

Install the Playwright MCP server in VS Code using one of these buttons:

<!--
// Generate using?:
const config = JSON.stringify({ name: 'playwright-mcp-bypass', command: 'npx', args: ["-y", "playwright-mcp-bypass@latest"] });
const urlForWebsites = `vscode:mcp/install?${encodeURIComponent(config)}`;
// Github markdown does not allow linking to `vscode:` directly, so you can use our redirect:
const urlForGithub = `https://insiders.vscode.dev/redirect?url=${encodeURIComponent(urlForWebsites)}`;
-->

[<img src="https://img.shields.io/badge/VS_Code-VS_Code?style=flat-square&label=Install%20Server&color=0098FF" alt="Install in VS Code">](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522playwright-mcp-bypass%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522playwright-mcp-bypass%2540latest%2522%255D%257D)  [<img alt="Install in VS Code Insiders" src="https://img.shields.io/badge/VS_Code_Insiders-VS_Code_Insiders?style=flat-square&label=Install%20Server&color=24bfa5">](https://insiders.vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522playwright-mcp-bypass%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522playwright-mcp-bypass%2540latest%2522%255D%257D)

Alternatively, you can install the Playwright MCP server using the VS Code CLI:

```bash
# For VS Code
code --add-mcp '{"name":"playwright-mcp-bypass","command":"npx","args":["playwright-mcp-bypass@latest"]}'
```

```bash
# For VS Code Insiders
code-insiders --add-mcp '{"name":"playwright-mcp-bypass","command":"npx","args":["playwright-mcp-bypass@latest"]}'
```

After installation, the Playwright MCP server will be available for use with your GitHub Copilot agent in VS Code.

### CLI Options

The Playwright MCP server supports the following command-line options:

- `--browser <browser>`: Browser or chrome channel to use. Possible values:
  - `chrome`, `firefox`, `webkit`, `msedge`
  - Chrome channels: `chrome-beta`, `chrome-canary`, `chrome-dev`
  - Edge channels: `msedge-beta`, `msedge-canary`, `msedge-dev`
  - Default: `chrome`
- `--caps <caps>`: Comma-separated list of capabilities to enable, possible values: tabs, pdf, history, wait, files, install. Default is all.
- `--cdp-endpoint <endpoint>`: CDP endpoint to connect to
- `--executable-path <path>`: Path to the browser executable
- `--headless`: Run browser in headless mode (headed by default)
- `--port <port>`: Port to listen on for SSE transport
- `--http-port <port>`: Port to listen on for the request/response HTTP API.
- `--user-data-dir <path>`: Path to the user data directory
- `--vision`: Run server that uses screenshots (Aria snapshots are used by default)

### User data directory

Playwright MCP will launch the browser with the new profile, located at

```
- `%USERPROFILE%\AppData\Local\ms-playwright\mcp-chrome-profile` on Windows
- `~/Library/Caches/ms-playwright/mcp-chrome-profile` on macOS
- `~/.cache/ms-playwright/mcp-chrome-profile` on Linux
```

All the logged in information will be stored in that profile, you can delete it between sessions if you'd like to clear the offline state.


### Running headless browser (Browser without GUI).

This mode is useful for background or batch operations.

```js
{
  "mcpServers": {
    "playwright-mcp-bypass": {
      "command": "npx",
      "args": [
        "playwright-mcp-bypass@latest",
        "--headless"
      ]
    }
  }
}
```

### Running headed browser on Linux w/o DISPLAY

When running headed browser on system w/o display or from worker processes of the IDEs,
run the MCP server from environment with the DISPLAY and pass the `--port` flag to enable SSE transport.

```bash
npx playwright-mcp-bypass@latest --port 8931
```

And then in MCP client config, set the `url` to the SSE endpoint:

```js
{
  "mcpServers": {
    "playwright-mcp-bypass": {
      "url": "http://localhost:8931/sse"
    }
  }
}
### HTTP API Usage (Request/Response)

In addition to the default Stdio transport and the SSE transport (`--port`), this server provides a standard HTTP API for request/response interactions. This is useful for clients that prefer simple HTTP calls over persistent connections.

#### Enabling the HTTP API

To enable the HTTP API, use the `--http-port` command-line option:

```bash
npx playwright-mcp-bypass@latest --http-port 8080
```

The server will then listen on the specified port (e.g., 8080) for incoming HTTP requests.

#### Endpoints

- **Base Path**: `/tools/{tool_name}`
- **Method**:
    - `POST`: Used for executing most tools. Tool parameters are sent in the JSON request body.
    - `GET`: Can be used for specific read-only tools like `browser_tab_list`. No request body is needed.
- **Examples**:
    - `POST /tools/browser_navigate`
    - `POST /tools/browser_click`
    - `GET /tools/browser_tab_list`

#### Request Format (POST)

- **Headers**:
    - `Content-Type: application/json`
    - `Session-Id: <your_session_id>` (Optional, see Session Management)
- **Body**: A JSON object containing the parameters required by the specific tool.

Example (`browser_navigate`):
```json
{
  "url": "https://example.com"
}
```

Example (`browser_click`):
```json
{
  "element": "Login Button",
  "ref": "button#login"
}
```

#### Response Format

- **Content-Type**: `application/json`
- **Success (HTTP 200)**:
  ```json
  {
    "success": true,
    "result": { ... } // The result returned by the tool execution
  }
  ```
- **Error (HTTP 4xx/5xx)**:
  ```json
  {
    "success": false,
    "error": "Error message describing the failure"
  }
  ```

#### Session Management

The HTTP API manages browser state using sessions. Each session corresponds to an independent browser instance with its own context (unless a global `--user-data-dir` is specified).

- **Session ID**: Sessions are identified by the `Session-Id` HTTP header in the request.
- **Default Session**: If the `Session-Id` header is not provided, a default session named `"default"` is used.
- **Session Creation**: A new browser instance is automatically created when a request with a previously unseen `Session-Id` (or no ID for the default session) is received.
- **Session Reuse**: Subsequent requests with the same `Session-Id` will reuse the existing browser instance for that session.
- **Session Timeout**: Sessions automatically time out and close after 30 minutes of inactivity to conserve resources. Any request to an active session resets the timer.
- **User Data Directory**: By default, each session gets its own isolated user data directory (e.g., `~/.cache/ms-playwright/mcp-chromium-profile-<session_id>`). If you specify `--user-data-dir` when starting the server, *all* HTTP sessions will share that single directory, which can lead to conflicts and is generally not recommended for concurrent sessions.

#### Comparison with SSE Transport (`--port`)

- **SSE (`--port`)**: Establishes a persistent connection per client. State (browser instance) is tied to the connection lifetime. Communication is typically streaming (server sends events).
- **HTTP API (`--http-port`)**: Uses standard request/response cycles. State is managed via the `Session-Id` header and has a timeout. Simpler for clients that don't need persistent connections.

#### Examples

##### curl

```bash
# Navigate (uses default session if Session-Id header is omitted)
curl -X POST http://localhost:8080/tools/browser_navigate \
     -H "Content-Type: application/json" \
     -d '{ "url": "https://example.com" }'

# Click an element in a specific session
curl -X POST http://localhost:8080/tools/browser_click \
     -H "Content-Type: application/json" \
     -H "Session-Id: my-session-123" \
     -d '{ "element": "Login Button", "ref": "button#login" }'

# Get tab list (GET request, uses default session)
curl http://localhost:8080/tools/browser_tab_list

# Get tab list for a specific session
curl -H "Session-Id: my-session-123" http://localhost:8080/tools/browser_tab_list
```

##### JavaScript (fetch)

```javascript
// Navigate in default session
fetch('http://localhost:8080/tools/browser_navigate', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ url: 'https://example.com' })
})
.then(response => response.json())
.then(data => console.log(data));

// Type text in a specific session
fetch('http://localhost:8080/tools/browser_type', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Session-Id': 'user-abc-session'
  },
  body: JSON.stringify({
    element: "Search Input",
    ref: "input[name='q']",
    text: "Playwright MCP"
  })
})
.then(response => response.json())
.then(data => console.log(data));

// Get tab list for a specific session
fetch('http://localhost:8080/tools/browser_tab_list', {
  headers: {
    'Session-Id': 'user-abc-session'
  }
})
.then(response => response.json())
.then(data => console.log(data));
```

##### Python (requests)

```python
import requests
import json

base_url = 'http://localhost:8080/tools'
session_id = 'python-session-456'

# Navigate in a specific session
headers = {
    'Content-Type': 'application/json',
    'Session-Id': session_id
}
payload = {'url': 'https://github.com'}
response = requests.post(f'{base_url}/browser_navigate', headers=headers, data=json.dumps(payload))
print(response.json())

# Get tab list for the same session
headers_no_content = {'Session-Id': session_id}
response = requests.get(f'{base_url}/browser_tab_list', headers=headers_no_content)
print(response.json())
```
```

### Tool Modes

The tools are available in two modes:

1. **Snapshot Mode** (default): Uses accessibility snapshots for better performance and reliability
2. **Vision Mode**: Uses screenshots for visual-based interactions

To use Vision Mode, add the `--vision` flag when starting the server:

```js
{
  "mcpServers": {
    "playwright-mcp-bypass": {
      "command": "npx",
      "args": [
        "playwright-mcp-bypass@latest",
        "--vision"
      ]
    }
  }
}
```

Vision Mode works best with the computer use models that are able to interact with elements using
X Y coordinate space, based on the provided screenshot.

### Programmatic usage with custom transports

```js
import { createServer } from '@playwright/mcp';

// ...

const server = createServer({
  launchOptions: { headless: true }
});
transport = new SSEServerTransport("/messages", res);
server.connect(transport);
```

### Snapshot-based Interactions

- **browser_click**
  - Description: Perform click on a web page
  - Parameters:
    - `element` (string): Human-readable element description used to obtain permission to interact with the element
    - `ref` (string): Exact target element reference from the page snapshot

- **browser_hover**
  - Description: Hover over element on page
  - Parameters:
    - `element` (string): Human-readable element description used to obtain permission to interact with the element
    - `ref` (string): Exact target element reference from the page snapshot

- **browser_drag**
  - Description: Perform drag and drop between two elements
  - Parameters:
    - `startElement` (string): Human-readable source element description used to obtain permission to interact with the element
    - `startRef` (string): Exact source element reference from the page snapshot
    - `endElement` (string): Human-readable target element description used to obtain permission to interact with the element
    - `endRef` (string): Exact target element reference from the page snapshot

- **browser_type**
  - Description: Type text into editable element
  - Parameters:
    - `element` (string): Human-readable element description used to obtain permission to interact with the element
    - `ref` (string): Exact target element reference from the page snapshot
    - `text` (string): Text to type into the element
    - `submit` (boolean, optional): Whether to submit entered text (press Enter after)
    - `slowly` (boolean, optional): Whether to type one character at a time. Useful for triggering key handlers in the page. By default entire text is filled in at once.

- **browser_select_option**
  - Description: Select an option in a dropdown
  - Parameters:
    - `element` (string): Human-readable element description used to obtain permission to interact with the element
    - `ref` (string): Exact target element reference from the page snapshot
    - `values` (array): Array of values to select in the dropdown. This can be a single value or multiple values.

- **browser_snapshot**
  - Description: Capture accessibility snapshot of the current page, this is better than screenshot
  - Parameters: None

- **browser_take_screenshot**
  - Description: Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions.
  - Parameters:
    - `raw` (boolean, optional): Whether to return without compression (in PNG format). Default is false, which returns a JPEG image.

### Vision-based Interactions

- **browser_screen_move_mouse**
  - Description: Move mouse to a given position
  - Parameters:
    - `element` (string): Human-readable element description used to obtain permission to interact with the element
    - `x` (number): X coordinate
    - `y` (number): Y coordinate

- **browser_screen_capture**
  - Description: Take a screenshot of the current page
  - Parameters: None

- **browser_screen_click**
  - Description: Click left mouse button
  - Parameters:
    - `element` (string): Human-readable element description used to obtain permission to interact with the element
    - `x` (number): X coordinate
    - `y` (number): Y coordinate

- **browser_screen_drag**
  - Description: Drag left mouse button
  - Parameters:
    - `element` (string): Human-readable element description used to obtain permission to interact with the element
    - `startX` (number): Start X coordinate
    - `startY` (number): Start Y coordinate
    - `endX` (number): End X coordinate
    - `endY` (number): End Y coordinate

- **browser_screen_type**
  - Description: Type text
  - Parameters:
    - `text` (string): Text to type
    - `submit` (boolean, optional): Whether to submit entered text (press Enter after)

- **browser_press_key**
  - Description: Press a key on the keyboard
  - Parameters:
    - `key` (string): Name of the key to press or a character to generate, such as `ArrowLeft` or `a`

### Tab Management

- **browser_tab_list**
  - Description: List browser tabs
  - Parameters: None

- **browser_tab_new**
  - Description: Open a new tab
  - Parameters:
    - `url` (string, optional): The URL to navigate to in the new tab. If not provided, the new tab will be blank.

- **browser_tab_select**
  - Description: Select a tab by index
  - Parameters:
    - `index` (number): The index of the tab to select

- **browser_tab_close**
  - Description: Close a tab
  - Parameters:
    - `index` (number, optional): The index of the tab to close. Closes current tab if not provided.

### Navigation

- **browser_navigate**
  - Description: Navigate to a URL
  - Parameters:
    - `url` (string): The URL to navigate to

- **browser_navigate_back**
  - Description: Go back to the previous page
  - Parameters: None

- **browser_navigate_forward**
  - Description: Go forward to the next page
  - Parameters: None

### Keyboard

- **browser_press_key**
  - Description: Press a key on the keyboard
  - Parameters:
    - `key` (string): Name of the key to press or a character to generate, such as `ArrowLeft` or `a`

### Files and Media

- **browser_file_upload**
  - Description: Choose one or multiple files to upload
  - Parameters:
    - `paths` (array): The absolute paths to the files to upload. Can be a single file or multiple files.

- **browser_pdf_save**
  - Description: Save page as PDF
  - Parameters: None

### Utilities

- **browser_wait**
  - Description: Wait for a specified time in seconds
  - Parameters:
    - `time` (number): The time to wait in seconds (capped at 10 seconds)

- **browser_close**
  - Description: Close the page
  - Parameters: None

- **browser_install**
  - Description: Install the browser specified in the config. Call this if you get an error about the browser not being installed.
  - Parameters: None
