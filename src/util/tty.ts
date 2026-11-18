// State-changing commands (auth, setup, reporting enable/disable, schedule, purge, revoke, install, transcripts) need a
// terminal on stdin and stdout and a typed confirmation (SEC-6). A model's shell has no TTY, so an injected instruction
// cannot run them silently. This is a speed bump, not a wall: SECURITY.md says so.

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

export class TtyRequired extends Error {
  constructor(command: string) {
    super(
      `"${command}" changes state, so it runs only in your own Terminal (a TTY on stdin and stdout) with a typed confirmation. ` +
        'It cannot be run by an assistant or a script.',
    );
  }
}

export function requireTty(prompt: Prompt, command: string): void {
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
