/**
 * OpenGolem Agent Runner — container-side entry point.
 *
 * Reads a JSON prompt from stdin, invokes the Claude Agent SDK,
 * and writes results to stdout wrapped in sentinel markers.
 * Polls an IPC directory for follow-up messages to support multi-turn
 * conversations without restarting the container.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import { query } from '@anthropic-ai/claude-agent-sdk';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  soulMd?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface IpcMessage {
  type: 'message';
  text: string;
}

// ---------------------------------------------------------------------------
// Sentinel output
// ---------------------------------------------------------------------------

const OUTPUT_START = '---OPENGOLEM_OUTPUT_START---';
const OUTPUT_END = '---OPENGOLEM_OUTPUT_END---';

function writeOutput(obj: ContainerOutput): void {
  process.stdout.write(
    `\n${OUTPUT_START}\n${JSON.stringify(obj)}\n${OUTPUT_END}\n`,
  );
}

// ---------------------------------------------------------------------------
// Debug logger — writes to stderr only
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[agent-runner] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// IPC polling
// ---------------------------------------------------------------------------

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Wait for the next IPC message or the close sentinel.
 * Returns the message text on a new message, or null when _close is found.
 */
async function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      // Check close sentinel first
      if (fs.existsSync(IPC_CLOSE_SENTINEL)) {
        log('IPC close sentinel received');
        resolve(null);
        return;
      }

      // Scan for JSON message files
      let files: string[];
      try {
        files = fs
          .readdirSync(IPC_INPUT_DIR)
          .filter((f) => f.endsWith('.json') && f !== '_close');
      } catch {
        files = [];
      }

      if (files.length === 0) {
        setTimeout(poll, IPC_POLL_MS);
        return;
      }

      // Pick the oldest file (lowest filename = earliest timestamp)
      files.sort();
      const filePath = path.join(IPC_INPUT_DIR, files[0]);

      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        fs.unlinkSync(filePath); // Consume the file
        const msg = JSON.parse(raw) as IpcMessage;
        if (msg.type === 'message' && typeof msg.text === 'string') {
          log(`IPC message received: ${msg.text.slice(0, 80)}`);
          resolve(msg.text);
        } else {
          // Unknown message type — skip and keep polling
          setTimeout(poll, IPC_POLL_MS);
        }
      } catch (err) {
        log(
          `IPC read error: ${err instanceof Error ? err.message : String(err)}`,
        );
        setTimeout(poll, IPC_POLL_MS);
      }
    };

    poll();
  });
}

// ---------------------------------------------------------------------------
// Script execution
// ---------------------------------------------------------------------------

async function runScript(script: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', script], {
      timeout: 30_000,
    });
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    log(`Script output: ${combined.slice(0, 200)}`);
    return combined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Script error: ${msg}`);
    return `Script error: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Resolve the MCP server path relative to this file
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Read and parse stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const rawInput = Buffer.concat(chunks).toString('utf-8');

  let input: ContainerInput;
  try {
    input = JSON.parse(rawInput) as ContainerInput;
  } catch (err) {
    const msg = `Failed to parse stdin JSON: ${err instanceof Error ? err.message : String(err)}`;
    log(msg);
    writeOutput({ status: 'error', result: null, error: msg });
    process.exit(1);
  }

  log(
    `Starting agent for group=${input.groupFolder} jid=${input.chatJid} isMain=${input.isMain}`,
  );

  // If a script is provided, run it and prepend output to the prompt
  let effectivePrompt = input.prompt;
  if (input.script) {
    const scriptOutput = await runScript(input.script);
    if (scriptOutput) {
      effectivePrompt = `${effectivePrompt}\n\nScript output:\n${scriptOutput}`;
    }
  }

  // MCP server env vars — passed to the subprocess
  const mcpEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    OPENGOLEM_CHAT_JID: input.chatJid,
    OPENGOLEM_GROUP_FOLDER: input.groupFolder,
    OPENGOLEM_IS_MAIN: input.isMain ? '1' : '0',
  };

  // Session ID carries over across turns
  let currentSessionId = input.sessionId;

  // Multi-turn loop
  let turnIndex = 0;
  let currentPrompt = effectivePrompt;

  while (true) {
    log(
      `Running query, turn=${turnIndex === 0 ? 'first' : 'follow-up'} sessionId=${currentSessionId ?? 'none'}`,
    );

    let resultText = '';
    let newSessionId: string | undefined;

    try {
      const sdkOptions = {
        sessionId: currentSessionId,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        cwd: '/workspace/group',
        mcpServers: {
          opengolem: {
            type: 'stdio' as const,
            command: 'node',
            args: [mcpServerPath],
            env: mcpEnv,
          },
        },
      };

      const stream = query(currentPrompt, sdkOptions);

      for await (const event of stream) {
        const e = event as Record<string, unknown>;

        // Extract assistant text from message events
        if (e.type === 'assistant') {
          const message = e.message as Record<string, unknown> | undefined;
          if (message) {
            const content = message.content as
              | Array<Record<string, unknown>>
              | undefined;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && typeof block.text === 'string') {
                  resultText += block.text;
                }
              }
            }
          }
        }

        // Extract session ID from result events
        if (e.type === 'result') {
          if (typeof e.session_id === 'string') {
            newSessionId = e.session_id;
          }
          if (typeof e.result === 'string' && !resultText) {
            resultText = e.result;
          }
        }

        // System events carry the session ID too
        if (e.type === 'system' && typeof e.session_id === 'string') {
          newSessionId = e.session_id;
        }
      }

      if (newSessionId) {
        currentSessionId = newSessionId;
      }

      writeOutput({
        status: 'success',
        result: resultText || null,
        newSessionId: currentSessionId,
      });

      log(`Query complete, sessionId=${currentSessionId ?? 'none'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${msg}`);
      writeOutput({ status: 'error', result: null, error: msg });
      process.exit(1);
    }

    turnIndex++;

    // Wait for the next IPC message or close
    const nextText = await waitForIpcMessage();
    if (nextText === null) {
      // Close sentinel — we're done
      log('IPC closed, exiting');
      break;
    }

    currentPrompt = nextText;
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[agent-runner] fatal: ${msg}\n`);
  writeOutput({ status: 'error', result: null, error: msg });
  process.exit(1);
});
