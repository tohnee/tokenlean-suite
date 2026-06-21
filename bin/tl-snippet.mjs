#!/usr/bin/env node
/**
 * tl-snippet.mjs — Extract a specific function/class by name.
 *
 * Usage: tl-snippet <name> [path]
 *
 * Delegates to 02-mcp-server/lib/core.mjs's read logic.
 */
console.log(`[tokenlean] tl-snippet — extract function/class by name

Usage:
  tl-snippet <name>          Search all files for a function/class
  tl-snippet <name> [path]   Search only in the given file

This wraps the fs_read_hashed MCP tool from 02-mcp-server.
For full code reading, use the MCP server:
  cd tokenlean-suite/02-mcp-server
  npx tl-mcp stdio
`);
