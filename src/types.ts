/**
 * Shared TypeScript type definitions for OpenGolem.
 *
 * This module contains only interfaces and types — no runtime logic.
 * Import from here to get consistent types across the codebase.
 */

// Mount security types

export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath, mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

export interface AllowedRoot {
  path: string; // Absolute path or ~ for home
  allowReadWrite: boolean; // Whether r/w mounts allowed under this root
  description?: string;
}

export interface MountAllowlist {
  allowedRoots: AllowedRoot[];
  blockedPatterns: string[]; // Glob patterns for paths never to mount (e.g. ".ssh")
  nonMainReadOnly: boolean; // If true, non-main groups can only mount read-only
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

// Core group registration type

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for main control group
  assertivenessLevel?: number; // 0–10, default 10
}

// Inbound message from any channel

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

// Scheduled task

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// Channel abstraction

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}

export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
