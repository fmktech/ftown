import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { E2E_DIR } from "./config";

/** Fake supported agent: drains the real inbox and uses the shipped CLI to reply. */
export async function makeConversationAgent(directory: string): Promise<{ command: string; receipt: string }> {
  const script = join(directory, "conversation-agent.cjs");
  const receipt = join(directory, "conversation-received.json");
  const reply = join(directory, "conversation-reply.txt");
  const cli = join(E2E_DIR, "..", "bridge/dist/ftown-cli.js");
  await writeFile(reply, "Agent reply from the real CLI.\nSecond line.", "utf8");
  await writeFile(script, `const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const cli = ${JSON.stringify(cli)}, receipt = ${JSON.stringify(receipt)}, reply = ${JSON.stringify(reply)};
let done = false, received = false; const replyId = require('node:crypto').randomUUID();
setInterval(() => { if (done) return; try {
  if (!received) { const output = execFileSync(process.execPath, [cli, 'sessions', 'inbox', '--json'], { encoding: 'utf8', timeout: 10000 });
  const result = JSON.parse(output);
  if (!Array.isArray(result.messages) || !result.messages.length) return;
  fs.writeFileSync(receipt, JSON.stringify(result.messages)); received = true; }
  execFileSync(process.execPath, [cli, 'sessions', 'preview-reply', '--message-file', reply, '--id', replyId], { encoding: 'utf8', timeout: 10000 });
  done = true;
} catch {} }, 500);
`, "utf8");
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  return { command: `${quote(process.execPath)} ${quote(script)}`, receipt };
}
