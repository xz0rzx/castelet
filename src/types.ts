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

export interface GeneratedOutput {
  sourceFile: string;
  prompt: string;
  generatedTexts: { targetId: string; text: string }[];
  generatedAt: string;
}
