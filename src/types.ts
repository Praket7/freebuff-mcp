export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Capabilities {
  product: 'desktop' | 'cli' | 'unknown';
  version?: string;
  signedIn: boolean | 'unknown';
  orchestrator: boolean;
  readOnly: boolean;
  endpoints: string[];
  notes: string[];
}
export interface ProjectSummary { id: string; path: string; name?: string; metadata?: Json; }
export interface ThreadSummary { id: string; projectId?: string; title?: string; state?: string; model?: string; metadata?: Json; }
export interface ThreadDetail extends ThreadSummary { messages?: Json[]; activeWork?: Json; }

