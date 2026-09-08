export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Capabilities {
  product: 'desktop' | 'cli' | 'unknown';
  version?: string;
  signedIn: boolean | 'unknown';
  orchestrator: boolean;
  readOnly: boolean;
  endpoints: string[];
  notes: string[];
  status?: 'desktop_read_only' | 'desktop_writable' | 'cli_ready' | 'cli_unavailable' | 'not_found';
  liveProgress?: 'connected' | 'stale' | 'unavailable';
  selectedRuntime?: string;
}
export interface ProjectSummary { id: string; path: string; name?: string; metadata?: Json; }
export interface ThreadSummary { id: string; projectId?: string; title?: string; state?: string; model?: string; metadata?: Json; }
export interface ThreadDetail extends ThreadSummary { messages?: Json[]; activeWork?: Json; live?: ThreadProgressSnapshot; }
export type ThreadProgressKind = 'turn_state' | 'assistant_text' | 'tool_start' | 'tool_output' | 'file_change' | 'completed' | 'failed' | 'unknown';
export interface ThreadProgressEvent {
  sequence: number;
  threadId: string;
  timestamp: string;
  kind: ThreadProgressKind;
  phase?: 'planning' | 'reading_files' | 'running_tests' | 'editing_files' | 'reviewing_changes' | 'waiting_for_input' | 'completed' | 'failed' | 'unknown';
  state?: string;
  tool?: string;
  command?: string;
  text?: string;
  files?: string[];
  error?: string;
  raw?: Json;
}
export interface ThreadProgressSnapshot { threadId: string; currentState?: string; events: ThreadProgressEvent[]; nextSequence?: number; connected: boolean; stale: boolean; latestEventAt?: string; activeTool?: string; filesChanged?: string[]; phase?: ThreadProgressEvent['phase']; lastMeaningfulUpdate?: string; lastError?: string; secondsSinceLastEvent?: number; }
export interface ModelCapability { id: string; provider?: string; variants?: string[]; supportsReasoning?: boolean; supportsSessionChange?: boolean; source: 'desktop' | 'cli' | 'unknown'; }
