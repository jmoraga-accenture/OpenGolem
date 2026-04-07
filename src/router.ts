import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines: string[] = [];
  lines.push(`<context timezone="${escapeXml(timezone)}" />`);
  lines.push('<messages>');
  for (const m of messages) {
    const time = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const openTag = `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(time)}"${replyAttr}>`;
    if (m.reply_to_message_content != null && m.reply_to_sender_name != null) {
      lines.push(openTag);
      lines.push(
        `<quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>${escapeXml(m.content)}</message>`,
      );
    } else {
      lines.push(`${openTag}${escapeXml(m.content)}</message>`);
    }
  }
  lines.push('</messages>');
  return lines.join('\n');
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const result = stripInternalTags(rawText);
  return result === '' ? '' : result;
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((channel) => channel.ownsJid(jid));
}
