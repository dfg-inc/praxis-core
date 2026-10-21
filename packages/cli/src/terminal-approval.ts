import { createInterface } from "node:readline";
import type { ApprovalRequest, AskAnswer, UserApprovalChannel } from "@praxis/contracts";

/**
 * The CLI's own approval dialog: when a person runs `praxis ... --confirm YES` in an interactive terminal, the exact
 * action is printed and they must type "approve" to run it. Without a terminal (a pipe, CI, a script) there is nobody
 * to ask and the protected action is refused, exactly like an MCP client without a dialog.
 */
export function terminalApprovalChannel(): UserApprovalChannel | undefined {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  return {
    kind: "terminal-prompt",
    async ask(request: ApprovalRequest): Promise<AskAnswer> {
      process.stderr.write(`\nPraxis asks you to approve this action. Nothing runs until you do.\n\n${request.summary}\n\n${request.description}\n`);
      if (request.risks?.length) process.stderr.write(`\nRisks:\n${request.risks.map((risk) => `- ${risk}`).join("\n")}\n`);
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const reply = await new Promise<string>((resolveReply) => rl.question("\nType 'approve' to run exactly this, anything else rejects: ", resolveReply));
      rl.close();
      return reply.trim().toLowerCase() === "approve" ? { answer: "approve" } : { answer: "reject" };
    },
  };
}
