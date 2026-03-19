export type EntityType =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "code"
  | "pre"
  | "text_link"
  | "mention"
  | "hashtag"
  | "bot_command"
  | "url"
  | "email"
  | "spoiler"
  | "blockquote"
  | "custom_emoji";

export interface MessageEntity {
  type: EntityType;
  offset: number;
  length: number;
  url?: string;
  language?: string;
  userId?: string;
}

export type MediaType =
  | "photo"
  | "video"
  | "document"
  | "sticker"
  | "poll"
  | "voice"
  | "audio"
  | "other";

export interface MediaInfo {
  type: MediaType;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
  caption?: string;
}

export interface ForwardInfo {
  fromId?: string;
  fromName?: string;
  date?: string;
  channelPostId?: number;
}

export interface ParsedMessage {
  id: number;
  date: string;
  senderId: string;
  senderName: string;
  text: string;
  replyToMsgId?: number;
  entities: MessageEntity[];
  media?: MediaInfo;
  forward?: ForwardInfo;
}

export interface ParsedChat {
  chatId: string;
  chatTitle: string;
  type: "group" | "channel";
  collectedAt: string;
  messages: ParsedMessage[];
}

export interface ParsedPost {
  postId: number;
  postText: string;
  postEntities: MessageEntity[];
  postMedia?: MediaInfo;
  comments: ParsedMessage[];
}

export interface ParsedChannelComments {
  chatId: string;
  chatTitle: string;
  type: "channel_comments";
  collectedAt: string;
  posts: ParsedPost[];
}

export interface ProxyConfigSocks {
  ip: string;
  port: number;
  timeout?: number;
  username?: string;
  password?: string;
  socksType: 4 | 5;
}

export interface ProxyConfigMTProxy {
  ip: string;
  port: number;
  timeout?: number;
  username?: string;
  password?: string;
  secret: string;
  MTProxy: true;
}

export type ProxyConfig = ProxyConfigSocks | ProxyConfigMTProxy;

export interface GeneratedOutput {
  sourceFile: string;
  prompt: string;
  generatedTexts: { targetId: string; text: string }[];
  generatedAt: string;
}

export interface TgSession {
  name: string;
  sessionString: string;
  phone: string;
  displayName: string;
  createdAt: string;
  lastUsedAt: string | null;
  proxy?: ProxyConfig;
}

export interface SessionRegistry {
  activeSession: string;
  sessions: TgSession[];
}
