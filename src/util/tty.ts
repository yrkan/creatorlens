// State-changing commands (auth, setup, reporting enable/disable, schedule, purge, revoke, install, transcripts) need a
// terminal on stdin and stdout, a typed confirmation, and a shell that no AI assistant started (SEC-6).
//
// This is a speed bump, not a wall (SECURITY.md). A shell can open a pseudo-terminal (script(1), expect, a pty module)
// and type the phrase, so the TTY check alone does not stop an assistant's shell. The agent check refuses the shells
// Claude Code starts: it sets CLAUDE_CODE_CHILD_SESSION=1 in every command its Bash, PowerShell and Monitor tools run
// (Claude Code 2.1.172 and later), and not in IDE terminals or stdio MCP servers. A shell that removes the variable on
// purpose still passes. The wall is the analysis folder's settings: the assistant's shell stays on "ask".

import readline from 'node:readline/promises';

export interface Prompt {
  isTTY(): boolean;
  ask(question: string): Promise<string>;
}

export const realPrompt: Prompt = {
  isTTY: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  async ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  },
};

/** Environment variables that only an AI assistant's own shell carries. */
export const AGENT_SHELL_VARS = ['CLAUDE_CODE_CHILD_SESSION'] as const;

/** The variable showing that an AI assistant's shell started this process, if any. */
export function agentShell(env: NodeJS.ProcessEnv): string | undefined {
  return AGENT_SHELL_VARS.find((v) => Boolean(env[v]));
}

export class TtyRequired extends Error {
  constructor(command: string, reason: 'no_tty' | 'agent_shell' = 'no_tty') {
    super(
      reason === 'agent_shell'
        ? `"${command}" changes state, so it is the owner's own command. This shell was started by an AI assistant, and creatorlens refuses it here. ` +
            'Run it yourself, in a terminal window that no assistant opened.'
        : `"${command}" changes state, so it runs only in your own Terminal (a TTY on stdin and stdout) with a typed confirmation. ` +
            'An assistant or a script must not run it.',
    );
  }
}

/** Refuses unless stdin and stdout are a terminal and no AI assistant's shell started this process. */
export function requireTty(prompt: Prompt, command: string, env: NodeJS.ProcessEnv): void {
  if (agentShell(env)) throw new TtyRequired(command, 'agent_shell');
  if (!prompt.isTTY()) throw new TtyRequired(command);
}

/** Asks the operator to type `phrase` exactly; anything else cancels. */
export async function confirmTyped(prompt: Prompt, explanation: string, phrase: string): Promise<boolean> {
  const answer = await prompt.ask(`${explanation}\nType "${phrase}" to continue, anything else to cancel: `);
  return answer === phrase;
}

/** A scripted prompt for tests: answers in order, reports itself as a TTY unless told otherwise. */
export class ScriptedPrompt implements Prompt {
  readonly asked: string[] = [];
  private readonly answers: string[];
  private readonly tty: boolean;
  constructor(answers: string[], tty = true) {
    this.answers = answers;
    this.tty = tty;
  }
  isTTY(): boolean {
    return this.tty;
  }
  async ask(question: string): Promise<string> {
    this.asked.push(question);
    const a = this.answers.shift();
    if (a === undefined) throw new Error(`ScriptedPrompt ran out of answers at: ${question}`);
    return a;
  }
}
