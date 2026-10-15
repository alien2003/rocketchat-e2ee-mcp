/**
 * Response schemas for the read-only REST endpoints we use (Rocket.Chat 8.9.0, verified against
 * packages/rest-typings and apps/meteor/server/api/v1). Objects are "loose": unknown fields pass through so a
 * newer server does not break us, but the fields we rely on are validated at the trust boundary.
 */
import { z } from 'zod';

const isoDate = z.string();

export const UserRef = z.looseObject({
  _id: z.string(),
  username: z.string().optional(),
  name: z.string().optional(),
});

export const Message = z.looseObject({
  _id: z.string(),
  rid: z.string(),
  ts: isoDate,
  _updatedAt: isoDate.optional(),
  msg: z.string().optional(),
  t: z.string().optional(),
  u: UserRef,
  tmid: z.string().optional(),
  tcount: z.number().optional(),
  tlm: isoDate.optional(),
  tshow: z.boolean().optional(),
  editedAt: isoDate.optional(),
  editedBy: UserRef.optional().nullable(),
  content: z.unknown().optional(),
  attachments: z.array(z.unknown()).optional(),
  file: z.unknown().optional(),
  files: z.array(z.unknown()).optional(),
  pinned: z.boolean().optional(),
  _hidden: z.boolean().optional(),
});
export type Message = z.infer<typeof Message>;

export const OldRoomKey = z.looseObject({
  e2eKeyId: z.string(),
  ts: z.unknown().optional(),
  E2EKey: z.string(),
});

export const Subscription = z.looseObject({
  _id: z.string(),
  rid: z.string(),
  t: z.string(),
  name: z.string().optional(),
  fname: z.string().optional(),
  open: z.boolean().optional(),
  archived: z.boolean().optional(),
  ls: isoDate.optional(),
  lr: isoDate.optional(),
  unread: z.number().optional(),
  _updatedAt: isoDate.optional(),
  E2EKey: z.string().optional().nullable(),
  E2ESuggestedKey: z.string().optional().nullable(),
  oldRoomKeys: z.array(OldRoomKey).optional().nullable(),
  suggestedOldRoomKeys: z.array(OldRoomKey).optional().nullable(),
});
export type Subscription = z.infer<typeof Subscription>;

export const Room = z.looseObject({
  _id: z.string(),
  t: z.string(),
  name: z.string().optional().nullable(),
  fname: z.string().optional().nullable(),
  encrypted: z.boolean().optional(),
  e2eKeyId: z.string().optional().nullable(),
  lm: isoDate.optional().nullable(),
  lastMessage: z.unknown().optional(),
  usernames: z.array(z.string()).optional(),
  uids: z.array(z.string()).optional(),
  topic: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  archived: z.boolean().optional(),
  teamMain: z.boolean().optional(),
  prid: z.string().optional().nullable(),
  msgs: z.number().optional(),
  ts: isoDate.optional(),
  _updatedAt: isoDate.optional(),
});
export type Room = z.infer<typeof Room>;

export const User = z.looseObject({
  _id: z.string(),
  username: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  statusText: z.string().optional(),
  bio: z.string().optional(),
  active: z.boolean().optional(),
  type: z.string().optional(),
  utcOffset: z.number().optional(),
  roles: z.array(z.string()).optional(),
});
export type User = z.infer<typeof User>;

export const Upload = z.looseObject({
  _id: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
  typeGroup: z.string().optional(),
  size: z.number().optional(),
  rid: z.string().optional(),
  userId: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  uploadedAt: isoDate.optional(),
  content: z.unknown().optional(),
  user: UserRef.optional(),
});
export type Upload = z.infer<typeof Upload>;

const Paged = { count: z.number().optional(), offset: z.number().optional(), total: z.number().optional() };

export const Cursor = z.looseObject({
  next: z.string().nullable().optional(),
  previous: z.string().nullable().optional(),
});

export const Me = z.looseObject({
  _id: z.string(),
  username: z.string().optional(),
  name: z.string().optional(),
  roles: z.array(z.string()).optional(),
  active: z.boolean().optional(),
  services: z.unknown().optional(),
});
export type Me = z.infer<typeof Me>;

export const ServerInfo = z.looseObject({ version: z.string().optional() });

/** The complete allowlist. Every entry is an HTTP GET without side effects (checked in the 8.9.0 source). */
export const ENDPOINTS = {
  me: Me,
  'rooms.get': z.looseObject({ update: z.array(Room), remove: z.array(z.unknown()).optional() }),
  'rooms.info': z.looseObject({ room: Room }),
  'rooms.history': z.looseObject({ messages: z.array(Message), cursor: Cursor.optional() }),
  'subscriptions.get': z.looseObject({ update: z.array(Subscription), remove: z.array(z.unknown()).optional() }),
  'subscriptions.getOne': z.looseObject({ subscription: Subscription.nullable() }),
  'chat.syncMessages': z.looseObject({
    result: z.looseObject({
      updated: z.array(Message),
      deleted: z.array(z.looseObject({ _id: z.string(), _deletedAt: z.unknown().optional() })),
      cursor: Cursor.optional(),
    }),
  }),
  'chat.getMessage': z.looseObject({ message: Message }),
  'chat.getThreadMessages': z.looseObject({ messages: z.array(Message), ...Paged }),
  'chat.getThreadsList': z.looseObject({ threads: z.array(Message), ...Paged }),
  'chat.search': z.looseObject({ messages: z.array(Message) }),
  'users.info': z.looseObject({ user: User }),
  'e2e.fetchMyKeys': z.looseObject({
    public_key: z.string().optional().nullable(),
    private_key: z.string().optional().nullable(),
  }),
  'groups.files': z.looseObject({ files: z.array(Upload), ...Paged }),
  'channels.files': z.looseObject({ files: z.array(Upload), ...Paged }),
  'im.files': z.looseObject({ files: z.array(Upload), ...Paged }),
} as const;

export type EndpointName = keyof typeof ENDPOINTS;
export type EndpointResponse<K extends EndpointName> = z.infer<(typeof ENDPOINTS)[K]>;

/** Endpoints that are never allowed, with the reason (documentation + guard test). */
export const FORBIDDEN_ENDPOINTS: Record<string, string> = {
  logout: 'GET /api/v1/logout revokes the calling token, including PATs',
  'chat.ignoreUser': 'GET with side effects (mutates the subscription)',
  'im.history': 'can create a DM when given a username / non-DM id; use rooms.history',
  'dm.history': 'alias of im.history',
  'im.messages': 'same DM auto-creation path; use rooms.history',
  'e2e.acceptSuggestedGroupKey': 'mutates subscriptions; v1 never accepts suggested keys',
};
