/**
 * example.flow.mjs - template workflow: review files, verify each finding, synthesize.
 *
 * Run it inside an ftown session:
 *
 *   ~/.ftown/ftown-workflows run example.flow.mjs \
 *     --args '{"files":["src/auth.ts","src/api.ts","src/db.ts"]}' \
 *     --workdir /path/to/your/repo
 *
 * Add --run-id <previous-id> to resume a partial run without re-running
 * steps whose result files already exist.
 */

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'severity', 'evidence'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          severity: { type: 'string' },
          evidence: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['isReal', 'reason'],
  properties: {
    isReal: { type: 'boolean' },
    reason: { type: 'string' },
  },
};

const REPORT_SCHEMA = {
  type: 'object',
  required: ['summary', 'confirmed', 'rejected'],
  properties: {
    summary: { type: 'string' },
    confirmed: { type: 'array', items: { type: 'string' } },
    rejected: { type: 'array', items: { type: 'string' } },
  },
};

function requireAgentResult(value, label) {
  if (value == null) {
    throw new Error(`${label} failed; aborting dependent workflow phases`);
  }
  return value;
}

function stepKey(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'item';
}

function asFindings(value) {
  return value && Array.isArray(value.findings) ? value.findings : [];
}

/**
 * @param {import('../../../src/workflow-runner.js').WorkflowContext} ctx
 */
export default async function (ctx) {
  const files = Array.isArray(ctx.args?.files)
    ? ctx.args.files
    : ['src/auth.ts', 'src/api.ts', 'src/db.ts'];

  ctx.phase('Setup');
  ctx.log(`Reviewing ${files.length} file(s): ${files.join(', ')}`);
  ctx.log(`Budget: ${ctx.budget.maxAgents ?? 'unlimited'} agents`);

  const reviewed = await ctx.pipeline(
    files,
    async (file) => {
      const review = await ctx.agent(
        `Review ${file} for correctness, security, and maintainability bugs.
Return only concrete findings with evidence. Do not include style preferences.`,
        {
          label: `review-${stepKey(file)}`,
          phase: 'Review',
          schema: FINDINGS_SCHEMA,
        },
      );

      return {
        file,
        findings: asFindings(requireAgentResult(review, `review ${file}`)),
      };
    },
    async (review) => {
      if (review.findings.length === 0) {
        ctx.log(`No findings reported for ${review.file}`);
        return { file: review.file, confirmed: [], rejected: [] };
      }

      const verified = await ctx.parallel(
        review.findings.map((finding, index) => async () => {
          const verdict = await ctx.agent(
            `Try to refute this finding. Default to isReal=false if the evidence is weak,
not reproducible, or not actually caused by the code.

Finding:
${JSON.stringify(finding, null, 2)}`,
            {
              label: `verify-${stepKey(review.file)}-${index}`,
              phase: 'Verify',
              schema: VERDICT_SCHEMA,
            },
          );

          return {
            finding,
            verdict: requireAgentResult(verdict, `verify ${review.file} #${index + 1}`),
          };
        }),
      );

      const kept = [];
      const rejected = [];
      for (const item of verified.filter(Boolean)) {
        if (item.verdict.isReal === true) kept.push(item.finding);
        else rejected.push({ finding: item.finding, reason: item.verdict.reason });
      }

      return { file: review.file, confirmed: kept, rejected };
    },
  );

  const completed = reviewed.filter(Boolean);
  const confirmed = completed.flatMap((entry) => entry.confirmed);
  const rejected = completed.flatMap((entry) => entry.rejected);

  ctx.phase('Synthesis');
  if (confirmed.length === 0) {
    ctx.log('No confirmed findings survived verification');
    return {
      summary: 'No confirmed findings survived adversarial verification.',
      confirmed: [],
      rejected: rejected.map((entry) => entry.finding.title),
    };
  }

  const report = await ctx.agent(
    `Write a concise final code-review report from these verified findings.
Group by severity and include evidence. Mention rejected findings only if useful.

Confirmed:
${JSON.stringify(confirmed, null, 2)}

Rejected:
${JSON.stringify(rejected, null, 2)}`,
    {
      label: 'synthesis',
      phase: 'Synthesis',
      schema: REPORT_SCHEMA,
    },
  );

  ctx.log(`Done. Budget used: ${ctx.budget.spent()} agent spawn(s).`);
  return requireAgentResult(report, 'synthesis');
}
