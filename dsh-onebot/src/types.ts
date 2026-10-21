export interface Segment { type: string; data: Record<string, unknown> }
export interface MessageEvent {
  post_type: string;
  self_id: number | string;
  user_id: number | string;
  message_id: number | string;
  group_id?: number | string;
  message_type: 'group' | 'private';
  message: Segment[] | string;
  time: number;
  sender?: { nickname?: string; card?: string };
}
export interface Policy {
  httpUrl: string; wsUrl: string; onebotConfigFile: string;
  allowedGroupIds: string[]; allowedPrivateIds: string[]; ownerIds: string[];
  workspace: string; stateDir: string; persona: string;
  provider: string; model: string;
  enabled: boolean; maxQueue: number; maxPerHour: number; timeoutMs: number;
  databaseConfigFile: string;
  replayFile?: string;
  expectedSelfId?: string;
  memory?: { enabled: boolean; contextLimit?: number; personalProfiles?: boolean };
  attention?: import('./attention.js').AttentionConfig;
  conversationLearning?: {enabled:boolean;identityName?:string};
  memes?: {enabled:boolean;cooldownMs?:number};
  bilibili?: import('./bilibili.js').BiliConfig;
  web?: import('./web.js').WebConfig;
  habits?: {enabled:boolean;unifiedPersona?:boolean};
}
export type Api = <T = Record<string, unknown>>(action: string, args?: Record<string, unknown>) => Promise<T>;
