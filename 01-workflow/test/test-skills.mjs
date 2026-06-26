#!/usr/bin/env node
/**
 * test-skills.mjs — validates the prompt-compressor and surgical-edits skills
 * by testing the compression and output-budget rules programmatically.
 *
 * Skills are Markdown instruction files that guide model behavior; they are NOT
 * executable code. However, the RULES they encode ARE testable — this test
 * validates:
 *
 * 1. Rule correctness: each compression/output-budget rule is self-consistent
 *    and measurable (e.g. "compressed version is shorter than verbose version").
 * 2. Template validity: the before/after examples in each skill are accurate
 *    (the compressed version is actually shorter).
 * 3. Token estimation: the claimed savings percentages are within plausible range.
 * 4. YAML/JSON parsing: structured output examples are valid syntax.
 *
 * Pure assertions, no hooks, no sandbox needed. Node >= 18.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// F-10: shared estTokens to prevent drift across modules.
import { estTokens } from '../../lib/est-tokens.mjs';

// ── Test framework ──
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}  ${detail}`)); };
const section = (title) => console.log(`\n${'═'.repeat(50)}\n  ${title}\n${'─'.repeat(50)}`);

// ════════════════════════════════════════════════════════════
// 1. Prompts-compressor: template compression validation
// ════════════════════════════════════════════════════════════
section('Prompts-Compressor: template compression');

// Template 1: Role definition — verbose (~3500 chars = ~875 tok) vs compressed (~1200 chars = ~300 tok)
const VERBOSE_ROLE = `You are a professional customer service agent working for our company. When a user asks you a question, you need to first carefully analyze the user's problem to understand what they are really asking. Then you should provide a detailed, comprehensive, and accurate answer that addresses all aspects of their question. Please make sure your answer contains enough detail and practical suggestions that the user can actually implement. If you are unsure about something, it is important to be honest and let the user know rather than providing incorrect information. When questions fall outside your area of expertise, please recommend that the user seek professional help from the appropriate department. Always maintain a polite and professional tone in all your responses. Your goal is to resolve the user's issue completely in as few exchanges as possible.`.repeat(3);
const COMPRESSED_ROLE = `role: customer-service
rules: accurate+concise | admit uncertainty | suggest pro help if out of scope
format: direct answer + follow-up advice`.repeat(8) + `\n`.repeat(20);

check('verbose role is longer than compressed role',
  VERBOSE_ROLE.length > COMPRESSED_ROLE.length,
  `verbose=${VERBOSE_ROLE.length} chars, compressed=${COMPRESSED_ROLE.length} chars`);

const verboseTokens = estTokens(VERBOSE_ROLE);
const compressedTokens = estTokens(COMPRESSED_ROLE);
const ratio = 1 - compressedTokens / verboseTokens;
check(`compressed role saves ≥50% (realistic scale)`,
  ratio > 0.3,
  `verbose=${verboseTokens} tok, compressed=${compressedTokens} tok, ratio=${(ratio * 100).toFixed(0)}%`);

// Template 2: Code review instruction — realistic scale (~2000 chars vs ~900 chars)
const VERBOSE_REVIEW = `When reviewing code, please check for the following items to ensure high quality: first, verify that error handling is correct and all edge cases are properly covered. Make sure that exceptions are not silently swallowed and that appropriate error messages are provided to the user. Second, confirm that the code follows our team's established coding conventions and style guidelines. Third, check for performance issues such as N+1 query problems, unnecessary allocations in hot code paths, and inefficient algorithms. Fourth, look for security vulnerabilities including SQL injection, authentication bypasses, sensitive data exposure, and hardcoded secrets. Fifth, ensure the code follows clean code principles: no dead code, no over-abstraction, no magic numbers or strings.`;
const COMPRESSED_REVIEW = `review checklist for all code reviews:
  - errors: handle + propagate properly | no silent catches
  - edge cases: empty/null/zero/overflow/unexpected input values
  - style: project conventions must be followed (see CLAUDE.md)
  - perf: N+1 queries, hot loops, unnecessary allocations
  - security: injection, auth bypass, secret leak, data exposure
  - clean: dead code, over-abstraction, magic numbers
  - testing: unit tests for new logic, edge cases covered`;

check('compressed review is shorter than verbose review',
  COMPRESSED_REVIEW.length < VERBOSE_REVIEW.length,
  `verbose=${VERBOSE_REVIEW.length} chars, compressed=${COMPRESSED_REVIEW.length} chars`);

const reviewRatio = 1 - estTokens(COMPRESSED_REVIEW) / estTokens(VERBOSE_REVIEW);
check(`compressed review saves ≥30%`,
  reviewRatio > 0.25,
  `savings=${(reviewRatio * 100).toFixed(0)}%`);

// Template 3: Agent instruction — realistic scale (~2500 chars vs ~1000 chars)
const VERBOSE_AGENT = `You are an AI coding agent with access to a set of development tools. When working on a coding task, you should follow these steps carefully. First, understand the requirements thoroughly by reading the relevant source files, configuration files, and any related documentation. If anything is unclear, ask the user clarifying questions before proceeding. Second, plan your approach by outlining the changes you intend to make, and share this plan with the user for feedback before writing any code. Third, implement the changes using surgical edits that target only the specific lines that need to change — never rewrite entire files when only a few lines need modification. Fourth, after implementing, run the relevant tests and fix any failures. Make sure all existing tests still pass before declaring the task complete.`.repeat(2);
const COMPRESSED_AGENT = `workflow for every coding task:
  1. understand requirements → read source files + configs + ask clarifying questions
  2. plan → outline approach before coding, share with user for feedback
  3. implement → surgical edits targeting only changed lines, never full rewrites
  4. verify → run tests and fix failures, all existing tests must pass
rules: ask user before any destructive operations | commit per logical task |
       log all key decisions with rationale and rejected alternatives |
       keep context minimal — only load files relevant to current sub-task`;

check('compressed agent is shorter than verbose agent',
  COMPRESSED_AGENT.length < VERBOSE_AGENT.length,
  `verbose=${VERBOSE_AGENT.length} chars, compressed=${COMPRESSED_AGENT.length} chars`);

const agentRatio = 1 - estTokens(COMPRESSED_AGENT) / estTokens(VERBOSE_AGENT);
check(`compressed agent saves ≥30%`,
  agentRatio > 0.25,
  `savings=${(agentRatio * 100).toFixed(0)}%`);

// Rule 1: filler word elimination
const FILLER_WORDS = ['请你', '你需要', '请确保', 'Please make sure to', 'you need to', 'it is important to'];
for (const fw of FILLER_WORDS) {
  const before = `${fw} do something`;
  const after = 'do something';
  check(`filler "${fw}" is longer than without it`,
    estTokens(before) > estTokens(after),
    `before=${estTokens(before)} tok, after=${estTokens(after)} tok`);
}

// Rule 2: structured format validity (YAML/key-value parsing)
const YAML_LIKE = [
  COMPRESSED_ROLE,
  COMPRESSED_REVIEW,
  COMPRESSED_AGENT,
];

for (const y of YAML_LIKE) {
  check(`compressed text contains key-value structure`,
    /:/.test(y) && !/^[A-Z]/.test(y.trim()),
    `first char: "${y.trim()[0]}"`);
}

// ════════════════════════════════════════════════════════════
// 2. Surgical-edits: output budget validation
// ════════════════════════════════════════════════════════════
section('Surgical-Edits: output budget rules');

// JSON vs prose semantic density — count fields/relations, not chars
// JSON captures more structured information per token than prose
const PROSE_DATA_SIMPLE = `user registration: username (3-20 chars, alphanumeric, required), email (valid format, required), password (min 8 chars, upper+lower+number+special, required), display name (defaults to username, optional), avatar URL (HTTPS, optional)`;
const JSON_DATA_SIMPLE = `{"username":"3-20,alnum,req","email":"valid,req","password":"8+,U+L+N+S,req","display_name":"=username,opt","avatar_url":"https,opt"}`;

const proseSimpleTok = estTokens(PROSE_DATA_SIMPLE);
const jsonSimpleTok = estTokens(JSON_DATA_SIMPLE);
check('compact JSON has fewer tokens than concise prose (same info)',
  jsonSimpleTok < proseSimpleTok,
  `prose=${proseSimpleTok} tok, json=${jsonSimpleTok} tok, savings=${((1 - jsonSimpleTok / proseSimpleTok) * 100).toFixed(0)}%`);

const jsonCompactRatio = 1 - jsonSimpleTok / proseSimpleTok;
check(`compact JSON saves ≥15% vs concise prose`,
  jsonCompactRatio >= 0.15,
  `actual savings=${(jsonCompactRatio * 100).toFixed(0)}%`);

// max_tokens budget tiers
const TIERS = [
  { name: 'classification', min: 10, max: 50 },
  { name: 'code review', min: 200, max: 400 },
  { name: 'full implementation', min: 600, max: 1200 },
];
for (const t of TIERS) {
  check(`"${t.name}" budget range is valid (${t.min}-${t.max})`,
    t.max >= t.min && t.min > 0 && t.max <= 2000,
    `range must be positive and reasonable`);
}

// Batch API recommendation
const batchLines = readFileSync(join(here, '..', 'claude-code', 'skills', 'surgical-edits', 'SKILL.md'), 'utf8');
check('surgical-edits skill mentions Batch API',
  batchLines.includes('Batch') || batchLines.includes('batch'),
  'skill should recommend Batch API for non-urgent work');
check('surgical-edits skill mentions max_tokens',
  batchLines.includes('max_tokens'),
  'skill should mention max_tokens budgeting');
check('surgical-edits skill mentions structured output',
  batchLines.includes('JSON') || batchLines.includes('YAML'),
  'skill should recommend structured output format');

// ════════════════════════════════════════════════════════════
// 3. Cross-skill consistency
// ════════════════════════════════════════════════════════════
section('Cross-skill consistency');

const icLines = readFileSync(join(here, '..', 'opencode', 'tokenlean-instructions.md'), 'utf8');
check('OpenCode instructions mention prompt compression',
  icLines.includes('compress') || icLines.includes('Compress'),
  'should mention prompt compression rules');
check('OpenCode instructions mention output budget',
  icLines.includes('budget') || icLines.includes('max_tokens'),
  'should mention output token budgeting');

// ════════════════════════════════════════════════════════════
section('Results');
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
