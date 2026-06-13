/**
 * example.flow.mjs — template workflow: parallel code review fan-out + synthesis.
 *
 * Run it inside an ftown session:
 *
 *   ~/.ftown/ftown-workflows run example.flow.mjs \
 *     --args '{"files":["src/auth.ts","src/api.ts","src/db.ts"]}' \
 *     --workdir /path/to/your/repo
 *
 * Add --run-id <previous-id> to resume a partial run without re-running
 * steps whose result files already exist.
 *
 * The script exports a default async function that receives a WorkflowContext.
 * The engine wires FTOWN_SESSION_ID from the calling session so children are
 * registered as its children and are cleaned up on completion.
 */

/**
 * @param {import('../../../src/workflow-runner.js').WorkflowContext} ctx
 */
export default async function (ctx) {
  // ── 1. Unpack args ──────────────────────────────────────────────────────────
  // ctx.args is whatever was passed via --args (JSON-parsed).
  // Provide a sensible fallback so the example runs without arguments too.
  const files = /** @type {string[]} */ (
    Array.isArray(ctx.args?.files)
      ? ctx.args.files
      : ['src/auth.ts', 'src/api.ts', 'src/db.ts']
  );

  ctx.phase('Setup');
  ctx.log(`Reviewing ${files.length} file(s): ${files.join(', ')}`);
  ctx.log(`Budget: ${ctx.budget.maxAgents ?? 'unlimited'} agents`);

  // ── 2. Fan-out: one reviewer per file, all running in parallel ───────────────
  // ctx.parallel() is a BARRIER — it waits for every thunk before returning.
  // A thunk that errors or whose agent returns null produces a null entry;
  // the whole call never rejects.
  // The concurrency cap (--concurrency, default 4) limits how many real sessions
  // run simultaneously — you can safely pass more thunks than the cap.
  ctx.phase('Review');

  const reviews = await ctx.parallel(
    files.map((file) => async () => {
      // Each thunk is an async function returning a string (or null on failure).
      const result = await ctx.agent(
        // The prompt is the full task description for this child session.
        // Keep it self-contained — the child has no other context.
        `You are a code reviewer. Review the file \`${file}\` for:
- Security vulnerabilities (auth bypass, injection, secret leakage)
- Correctness bugs (off-by-one, null dereference, missing error handling)
- Style issues that reduce readability

Reply with a concise bullet-point list. Start with "## ${file}".`,
        {
          // label becomes the step key and the result filename.
          // Unique, filesystem-safe labels enable per-step resume.
          label: `review-${file.replace(/[^a-z0-9]/gi, '-')}`,
          // phase groups events in the log output.
          phase: 'review',
          // shell defaults to 'claude'; override here if needed.
          // shell: 'claude',
        },
      );

      if (result == null) {
        ctx.log(`WARN: review of ${file} failed or timed out`);
      }
      return result;
    }),
  );

  // ── 3. Filter out any failed reviews before synthesising ────────────────────
  const successfulReviews = reviews.filter(
    /** @param {string | null} r */ (r) => r != null,
  );

  if (successfulReviews.length === 0) {
    ctx.log('ERROR: all reviews failed — cannot synthesise');
    return null;
  }

  ctx.log(`${successfulReviews.length}/${files.length} reviews succeeded`);

  // ── 4. Single synthesis agent consolidates all reviewer findings ─────────────
  // This is a sequential step — one agent, no parallelism needed.
  ctx.phase('Synthesise');

  const synthesis = await ctx.agent(
    `You are a senior engineer writing a final code-review report.
Below are ${successfulReviews.length} individual file reviews.
Consolidate them into a single report with:
1. An executive summary (2-3 sentences).
2. Critical issues (must fix before merge).
3. Minor issues (nice to fix).
4. Positive observations.

--- REVIEWS ---
${successfulReviews.join('\n\n---\n\n')}`,
    {
      label: 'synthesis',
      phase: 'synthesise',
      // Use schema to get a structured JSON response instead of a string.
      // When schema is set, agent() returns the parsed object (or null).
      // Comment it out to get a plain string instead.
      schema: {
        type: 'object',
        required: ['summary', 'critical', 'minor', 'positives'],
        properties: {
          summary: { type: 'string' },
          critical: { type: 'array', items: { type: 'string' } },
          minor: { type: 'array', items: { type: 'string' } },
          positives: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  );

  // ── 5. Return value is printed by the CLI (pretty by default, --json for raw) ─
  ctx.log(`Done. Budget used: ${ctx.budget.spent()} agent spawn(s).`);
  return synthesis;
}
