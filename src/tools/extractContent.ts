import { Page } from 'playwright';
import { JSDOM } from 'jsdom';
// @ts-ignore - No official types for readability
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolFactory, ToolResult, ToolSchema } from './tool.js'; // Corrected import
import type { Context } from '../context.js'; // Corrected import

// Define the input schema using Zod
const ExtractContentInputSchema = z.object({
  url: z.string().url().describe('The URL of the web page to extract content from.'),
  // Optional: Add timeout, waitUntil etc. if needed
});

// Convert Zod schema to JSON schema for MCP
const extractContentInputJsonSchema = zodToJsonSchema(ExtractContentInputSchema);

// Tool Factory function
const extractContent: ToolFactory = (captureSnapshot) => ({
  capability: 'core', // Assign a capability
  schema: { // Define schema property
    name: 'browser_extract_content',
    description: 'Navigate to a URL and extract the main readable content as Markdown.',
    inputSchema: extractContentInputJsonSchema,
  },
  // Correct handle signature
  handle: async (context: Context, params?: Record<string, any>): Promise<ToolResult> => {
    const { url } = ExtractContentInputSchema.parse(params);
    const currentTab = await context.ensureTab();
    const page = currentTab.page;

    try {
      console.log(`[browser_extract_content] Navigating to: ${url}`);
      // Navigate and wait for the page to load
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Optional: Add a small delay or wait for network idle if needed for dynamic content
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {
          console.log('[browser_extract_content] Page load timeout after domcontentloaded, proceeding anyway.');
      });
      console.log(`[browser_extract_content] Navigation successful.`);

      // Get page HTML content
      const html = await page.content();
      console.log(`[browser_extract_content] Retrieved HTML content (length: ${html.length}).`);

      if (!html) {
        throw new Error('Failed to retrieve HTML content from the page.');
      }

      // Process content using Readability and Turndown
      const processedContent = processHtmlContent(html, url);
      console.log(`[browser_extract_content] Processed content (length: ${processedContent.length}).`);

      // Return the extracted content directly
      return {
        content: [{ type: 'text', text: processedContent }],
        // isError can be omitted if success
      };

    } catch (error: any) {
      console.error(`[browser_extract_content] Error processing ${url}: ${error.message}`);
      // Return a structured error message
      const errorMessage = `<error>Failed to extract content from ${url}: ${error.message}</error>`;
      return {
        content: [{ type: 'text', text: errorMessage }],
        isError: true, // Mark as error
      };
    }
  },
});

/**
 * Helper function to process HTML content using Readability and Turndown.
 * @param html The HTML content string.
 * @param url The base URL for resolving relative links (optional).
 * @returns The processed content as Markdown string.
 */
function processHtmlContent(html: string, url?: string): string {
     try {
        const dom = new JSDOM(html, { url });
        // @ts-ignore
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.content) {
          console.warn('[browser_extract_content] Readability could not extract main content. Returning warning message.');
          // Return a more informative message instead of empty string
          return '<warning>Readability could not extract main content from this page.</warning>';
        }

        console.log(`[browser_extract_content] Readability extracted content (length: ${article.content.length}).`);

        // Convert extracted HTML to Markdown
        const turndownService = new TurndownService({
            headingStyle: 'atx', // Use '#' for headings
            codeBlockStyle: 'fenced', // Use ``` for code blocks
        });
        // Add a rule to handle preformatted text better
        turndownService.addRule('pre', {
            filter: 'pre',
            replacement: function (content, node) {
                // Trim leading/trailing newlines often added by turndown
                const code = content.replace(/^\n+|\n+$/g, '');
                // Attempt to get language from class attribute
                const language = (node as HTMLElement).getAttribute('class')?.match(/language-(\S+)/)?.[1] || '';
                return '\n```' + language + '\n' + code + '\n```\n';
            }
        });

        const markdown = turndownService.turndown(article.content);

        console.log(`[browser_extract_content] Converted to Markdown (length: ${markdown.length}).`);
        // Trim potential excessive newlines from the final markdown
        return markdown.replace(/\n{3,}/g, '\n\n').trim();

      } catch (error: any) {
          console.error(`[browser_extract_content] Error during HTML processing: ${error.message}`);
          // Return error message formatted as markdown error
          return `<error>Error processing HTML content: ${error.message}</error>`;
      }
}


// Export the factory function, likely in an array like other tools
export default (captureSnapshot: boolean) => [
  extractContent(captureSnapshot),
];