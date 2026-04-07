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

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { isChannelEnabled } from './channel-enabled.js';
import { Channel } from '../types.js';

export const TUI_CONSOLE_JID = 'tui:console';

/** Shape returned by getHealthStatus() — per channel-adapters-spec AC-9. */
export interface AdapterHealthStatus {
  channel: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  since: string;
}

/** Orchestrator health shape injected via setHealthProvider(). */
export interface OrchestratorHealth {
  status: string;
  quarantinedHanseiReports: number;
}

export class TuiChannel implements Channel {
  name = 'tui';

  private opts: ChannelOpts;
  private connected = false;
  private rl: readline.Interface | null = null;
  private connectedSince: string = new Date().toISOString();
  private healthProvider: (() => OrchestratorHealth) | null = null;

  // Health panel state (AC-13, AC-14)
  healthPanelVisible = false;
  // Explicit false — panel never accepts typed input (AC-14)
  healthPanelAcceptsInput = false;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  /**
   * Inject an orchestrator health provider so the health panel can show live data.
   * AC-13: "health panel displays most recent hansei report summary".
   */
  setHealthProvider(provider: () => OrchestratorHealth): void {
    this.healthProvider = provider;
  }

  /**
   * Normalise a raw readline line into an InboundMessage (orchestrator-spec §2.1)
   * and call opts.onMessage. Blank/whitespace-only lines are silently dropped.
   *
   * AC-3: Inbound message is normalised to InboundMessage format.
   */
  deliverLine(line: string): void {
    const text = line.trim();
    if (!text) return;

    const ts = new Date().toISOString();
    const messageId = `tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Ensure the chats row exists before storeMessage runs (FK constraint).
    this.opts.onChatMetadata(TUI_CONSOLE_JID, ts, 'Console', 'tui', false);

    this.opts.onMessage(TUI_CONSOLE_JID, {
      // Legacy NewMessage fields (consumed by orchestrator/db layer)
      id: messageId,
      chat_jid: TUI_CONSOLE_JID,
      sender: 'local',
      sender_name: 'You',
      content: text,
      timestamp: ts,
      is_from_me: true,
      // orchestrator-spec §2.1 InboundMessage fields
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      groupId: TUI_CONSOLE_JID,
      channelId: 'tui',
      senderId: 'tui-local',
      messageId,
      text,
      // ISO-8601 timestamp
      // (timestamp above satisfies this but spec field name is `timestamp`)
    } as any);
  }

  /**
   * Toggle the health panel visibility and, when turning on, render its content.
   * AC-13: Ctrl-D toggles the health panel.
   */
  toggleHealthPanel(): void {
    this.healthPanelVisible = !this.healthPanelVisible;
    if (this.healthPanelVisible) {
      this._renderHealthPanel();
    }
  }

  /** Render the health panel to stdout. */
  private _renderHealthPanel(): void {
    const health = this.healthProvider?.() ?? {
      status: 'ok',
      quarantinedHanseiReports: 0,
    };

    const isDegraded =
      health.status === 'degraded' || health.quarantinedHanseiReports > 0;
    const systemStatusLabel = isDegraded ? '[degraded]' : '[ok]';

    const lines: string[] = [
      '',
      '╔══════════════════════════════════════════╗',
      '║           SYSTEM STATUS ' + systemStatusLabel.padEnd(18) + '║',
      '╠══════════════════════════════════════════╣',
      '║  CHANNELS                                ║',
      `║  • tui: ${this.connected ? '[connected]' : '[disconnected]'}`.padEnd(
        45,
      ) + '║',
      '╠══════════════════════════════════════════╣',
      '║  TASKS                                   ║',
      '╠══════════════════════════════════════════╣',
      '║  GOVERNANCE                              ║',
      `║  Hansei reports pending: ${health.quarantinedHanseiReports}`.padEnd(
        45,
      ) + '║',
      isDegraded
        ? `║  Status: [degraded] — review required`.padEnd(45) + '║'
        : `║  Status: [ok]`.padEnd(45) + '║',
      '╠══════════════════════════════════════════╣',
      '║  Press Ctrl-D to close this panel        ║',
      '╚══════════════════════════════════════════╝',
      '',
    ];

    process.stdout.write(lines.join('\n'));
  }

  /**
   * Returns the prompt string shown at the readline prompt.
   * Uses ASSISTANT_NAME from config — not a hard-coded literal.
   * ux-review-tui-cli.md R5.
   */
  getPromptString(): string {
    return `${ASSISTANT_NAME}> `;
  }

  /**
   * Returns the adapter's health status for the channel registry query.
   * AC-9: { channel, status, since }
   */
  getHealthStatus(): AdapterHealthStatus {
    return {
      channel: 'tui',
      status: this.connected ? 'connected' : 'disconnected',
      since: this.connectedSince,
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    this.connectedSince = new Date().toISOString();
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
    rl.setPrompt(this.getPromptString());
    rl.prompt();

    rl.on('line', (line) => {
      this.deliverLine(line);
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
    // Must not silently suppress errors — AC-8 requires rejection on failure.
    // Wrap in try/catch to convert synchronous throws into rejected promises.
    try {
      const prefix = `\n${ASSISTANT_NAME}: `;
      process.stdout.write(`${prefix}${text}\n`);
    } catch (err) {
      return Promise.reject(err);
    }
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
