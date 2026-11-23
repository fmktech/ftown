export interface DiscussionAuthor { name: string; bridgeId?: string; sessionId?: string }
export interface DiscussionChannel { id: string; name: string; archived: boolean }
export interface DiscussionThread {
  seq: number; id: string; channelId: string; title: string; author: DiscussionAuthor; createdAt: string; ticketId: string | null;
}
export interface DiscussionPost {
  seq: number; id: string; threadId: string; text: string; author: DiscussionAuthor; createdAt: string;
}
