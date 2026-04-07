import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const chatJid = process.env['OPENGOLEM_CHAT_JID'];
const groupFolder = process.env['OPENGOLEM_GROUP_FOLDER'];
const isMain = process.env['OPENGOLEM_IS_MAIN'] === '1';

if (!chatJid) {
  throw new Error('OPENGOLEM_CHAT_JID is required');
}
if (!groupFolder) {
  throw new Error('OPENGOLEM_GROUP_FOLDER is required');
}

const IPC_MESSAGES_DIR = '/workspace/ipc/messages';
const IPC_TASKS_DIR = '/workspace/ipc/tasks';

function randomHex(bytes: number): string {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) {
    buf[i] = Math.floor(Math.random() * 256);
  }
  return buf.toString('hex');
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${randomHex(6)}.json`;
  const filepath = path.join(dir, filename);
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, filepath);
  return filename;
}

const server = new McpServer({ name: 'opengolem-ipc', version: '1.0.0' });

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running.",
  {
    text: z.string(),
    sender: z.string().optional(),
  },
  async (args) => {
    writeIpcFile(IPC_MESSAGES_DIR, {
      type: 'message',
      text: args.text,
      sender: args.sender,
      chatJid,
      timestamp: Date.now(),
    });
    return { content: [{ type: 'text' as const, text: 'Message queued.' }] };
  },
);

server.tool(
  'schedule_task',
  'Schedule a task to run at a specific time or on a recurring schedule.',
  {
    prompt: z.string(),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string(),
    context_mode: z.enum(['group', 'isolated']),
    name: z.string().optional(),
  },
  async (args) => {
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Invalid cron expression: ${String(err)}` }],
        };
      }
    }
    const filename = writeIpcFile(IPC_TASKS_DIR, {
      type: 'schedule_task',
      ...args,
      chatJid,
      groupFolder,
      timestamp: Date.now(),
    });
    return { content: [{ type: 'text' as const, text: `Task scheduled: ${filename}` }] };
  },
);

server.tool(
  'list_tasks',
  'List all scheduled tasks for this group.',
  {},
  async () => {
    if (!fs.existsSync(IPC_TASKS_DIR)) {
      return { content: [{ type: 'text' as const, text: 'No tasks scheduled.' }] };
    }
    const files = fs.readdirSync(IPC_TASKS_DIR).filter((f) => f.endsWith('.json'));
    const tasks: object[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(IPC_TASKS_DIR, file), 'utf8');
        const parsed = JSON.parse(raw) as { type?: string };
        if (parsed.type === 'schedule_task') {
          tasks.push({ file, ...parsed });
        }
      } catch {
        // skip unreadable files
      }
    }
    if (tasks.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No tasks scheduled.' }] };
    }
    const lines = tasks.map((t) => JSON.stringify(t, null, 2));
    return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
  },
);

server.tool(
  'update_task',
  'Update or cancel a scheduled task.',
  {
    task_id: z.string(),
    status: z.enum(['active', 'paused', 'completed']),
  },
  async (args) => {
    writeIpcFile(IPC_TASKS_DIR, {
      type: 'update_task',
      task_id: args.task_id,
      status: args.status,
      chatJid,
      timestamp: Date.now(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} updated to ${args.status}.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  'Register a new group to receive messages from.',
  {
    jid: z.string(),
    name: z.string(),
    folder: z.string(),
    trigger: z.string(),
  },
  async (args) => {
    if (!isMain) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: 'register_group is only allowed from the main group.',
          },
        ],
      };
    }
    writeIpcFile(IPC_TASKS_DIR, {
      type: 'register_group',
      ...args,
      timestamp: Date.now(),
    });
    return {
      content: [
        { type: 'text' as const, text: `Group ${args.name} registration queued.` },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
