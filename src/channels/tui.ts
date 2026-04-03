/**
 * Terminal UI channel — default OpenGolem ingress for local use.
 *
 * Uses a fixed chat JID `tui:console`. Register this JID to your main group
 * (see setup register) so inbound lines are routed like other channels.
 *
 * Under systemd or non-interactive runs there is no TTY: the channel still
 * "connects" so the process can stay up; stdin-driven input is inactive until
 * you run in a real terminal or add another channel (e.g. telegram).
 */
import readline from 'readline';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { isChannelEnabled } from './channel-enabled.js';
import { Channel } from '../types.js';

export const TUI_CONSOLE_JID = 'tui:console';

export class TuiChannel implements Channel {
  name = 'tui';

  private opts: ChannelOpts;
  private connected = false;
  private rl: readline.Interface | null = null;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!tty) {
      this.connected = true;
      logger.warn(
        'TUI: no interactive terminal (stdin/stdout not TTY) — console input disabled. ' +
          'Use OPENGOLEM_CHANNELS=telegram (or another channel) for headless messaging, ' +
          'or run `npm run dev` in a terminal for the TUI prompt.',
      );
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    this.rl = rl;
    rl.setPrompt('opengolem> ');
    rl.prompt();

    rl.on('line', (line) => {
      const text = line.trim();
      if (text.length > 0) {
        const ts = new Date().toISOString();
        // Ensure the chats row exists before storeMessage runs (FK constraint).
        this.opts.onChatMetadata(TUI_CONSOLE_JID, ts, 'Console', 'tui', false);
        this.opts.onMessage(TUI_CONSOLE_JID, {
          id: `tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: TUI_CONSOLE_JID,
          sender: 'local',
          sender_name: 'You',
          content: text,
          timestamp: ts,
          is_from_me: true,
        });
      }
      rl.prompt();
    });

    rl.on('close', () => {
      this.rl = null;
      this.connected = false;
      logger.info('TUI readline closed');
    });

    this.connected = true;
    logger.debug({ jid: TUI_CONSOLE_JID }, 'TUI channel ready');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) return;
    process.stdout.write(`\n${text}\n`);
    this.rl?.prompt(true);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tui:');
  }

  async disconnect(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.connected = false;
  }
}

registerChannel('tui', (opts: ChannelOpts) => {
  if (!isChannelEnabled('tui')) {
    return null;
  }
  return new TuiChannel(opts);
});
