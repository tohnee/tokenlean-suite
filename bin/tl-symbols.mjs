#!/usr/bin/env node
/**
 * tl-symbols.mjs — Show code structure outline (function/class signatures).
 *
 * Usage: tl-symbols [path] [-l N]
 *
 * Delegates to 02-mcp-server/lib/core.mjs's outline logic.
 */
console.log(`[tokenlean] tl-symbols — code structure outline

Usage:
  tl-symbols <path>     Show structure of a file or directory
  tl-symbols <path> -l N  Limit to N items

This wraps the fs_outline MCP tool from 02-mcp-server.
For a full outline, run:
  cd tokenlean-suite/02-mcp-server
  npx tl-mcp stdio
`);
