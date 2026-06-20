#!/usr/bin/env node
/**
 * server.mjs — backward-compatible shim.
 * The implementation now lives in lib/core.mjs (logic) + bin/stdio.mjs (CLI transport)
 * + bin/http.mjs (web transport). This shim keeps the old `node server.mjs --root .`
 * invocation working for the local CLI form.
 */
import('./bin/stdio.mjs');
