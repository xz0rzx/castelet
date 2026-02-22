export interface ParsedMessage {
  id: number;
  date: string;
  senderId: number;
  senderName: string;
  text: string;
  replyToMsgId?: number;
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
