import type { InferOutput } from 'valibot'

import {
  boolean,
  integer,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  number,
  parse,
  picklist,
  pipe,
  safeParse,
  strictObject,
  string,
  union,
} from 'valibot'

export const SCHEMA_VERSION = 1 as const
export const MAX_FRAME_BYTES = 16 * 1024

const id = pipe(string(), minLength(1), maxLength(128))
const token = pipe(string(), minLength(1), maxLength(4096))
const sequence = pipe(number(), integer(), minValue(0), maxValue(Number.MAX_SAFE_INTEGER))
const timestamp = pipe(number(), integer(), minValue(0), maxValue(Number.MAX_SAFE_INTEGER))
const envelope = {
  schemaVersion: literal(SCHEMA_VERSION),
}
export const AvatarBehaviorSchema = picklist(['idle', 'listening', 'thinking', 'speaking'])
export const StateResultStatusSchema = picklist(['accepted', 'duplicate', 'stale', 'conflict'])
export const OAuthExchangeRequestSchema = strictObject({
  code: pipe(string(), minLength(1), maxLength(4096)),
  guildId: id,
  channelId: id,
})
export const ViewerClaimsSchema = strictObject({
  ...envelope,
  userId: id,
  guildId: id,
  channelId: id,
  iat: timestamp,
  exp: timestamp,
})

export const PublisherHelloSchema = strictObject({
  ...envelope,
  type: literal('publisher.hello'),
  token,
})
export const ViewerHelloSchema = strictObject({
  ...envelope,
  type: literal('viewer.hello'),
  token,
})
export const StateSubscribeSchema = strictObject({
  ...envelope,
  type: literal('state.subscribe'),
  guildId: id,
  channelId: id,
})
export const StateUnsubscribeSchema = strictObject({
  ...envelope,
  type: literal('state.unsubscribe'),
  guildId: id,
  channelId: id,
})

const avatarStateFields = {
  guildId: id,
  channelId: id,
  sessionId: id,
  sequence,
  timestamp,
  connected: boolean(),
  behavior: AvatarBehaviorSchema,
  speaking: literal(false),
  mouthOpen: literal(0),
}

export const AvatarBehaviorSetSchema = strictObject({
  ...envelope,
  type: literal('avatar.behavior.set'),
  ...avatarStateFields,
})
export const AvatarStateSnapshotSchema = strictObject({
  ...envelope,
  type: literal('avatar.state.snapshot'),
  ...avatarStateFields,
})
export const StateResultSchema = strictObject({
  ...envelope,
  type: literal('state.result'),
  guildId: id,
  channelId: id,
  sessionId: id,
  sequence,
  status: StateResultStatusSchema,
})
export const HeartbeatSchema = strictObject({
  ...envelope,
  type: literal('heartbeat'),
  timestamp,
})
export const PongSchema = strictObject({
  ...envelope,
  type: literal('pong'),
  timestamp,
})
export const ErrorMessageSchema = strictObject({
  ...envelope,
  type: literal('error'),
  code: pipe(string(), minLength(1), maxLength(64)),
  message: pipe(string(), minLength(1), maxLength(256)),
})

export type AvatarBehavior = InferOutput<typeof AvatarBehaviorSchema>
export type StateResultStatus = InferOutput<typeof StateResultStatusSchema>
export type OAuthExchangeRequest = InferOutput<typeof OAuthExchangeRequestSchema>
export type ViewerClaims = InferOutput<typeof ViewerClaimsSchema>
export type PublisherHello = InferOutput<typeof PublisherHelloSchema>
export type ViewerHello = InferOutput<typeof ViewerHelloSchema>
export type StateSubscribe = InferOutput<typeof StateSubscribeSchema>
export type StateUnsubscribe = InferOutput<typeof StateUnsubscribeSchema>
export type AvatarBehaviorSet = InferOutput<typeof AvatarBehaviorSetSchema>
export type AvatarStateSnapshot = InferOutput<typeof AvatarStateSnapshotSchema>
export type StateResult = InferOutput<typeof StateResultSchema>
export type Heartbeat = InferOutput<typeof HeartbeatSchema>
export type Pong = InferOutput<typeof PongSchema>
export type ErrorMessage = InferOutput<typeof ErrorMessageSchema>

const PublisherInboundSchema = union([PublisherHelloSchema, AvatarBehaviorSetSchema, PongSchema])
const ViewerInboundSchema = union([ViewerHelloSchema, StateSubscribeSchema, StateUnsubscribeSchema, PongSchema])
const PublisherOutboundSchema = union([StateResultSchema, HeartbeatSchema, ErrorMessageSchema])
const ViewerOutboundSchema = union([AvatarStateSnapshotSchema, HeartbeatSchema, ErrorMessageSchema])

export class ProtocolError extends Error {
  constructor() {
    super('Invalid avatar protocol message')
    this.name = 'ProtocolError'
  }
}

function parseJson(input: string | ArrayBuffer | Uint8Array): unknown {
  try {
    const text = typeof input === 'string'
      ? input
      : new TextDecoder().decode(input)
    return JSON.parse(text)
  }
  catch {
    throw new ProtocolError()
  }
}

function parseDirection<TSchema>(schema: TSchema, input: string | ArrayBuffer | Uint8Array) {
  const result = safeParse(schema as Parameters<typeof safeParse>[0], parseJson(input))
  if (!result.success)
    throw new ProtocolError()
  return result.output
}

export function parsePublisherInbound(input: string | ArrayBuffer | Uint8Array) {
  return parseDirection(PublisherInboundSchema, input) as InferOutput<typeof PublisherInboundSchema>
}
export function parseViewerInbound(input: string | ArrayBuffer | Uint8Array) {
  return parseDirection(ViewerInboundSchema, input) as InferOutput<typeof ViewerInboundSchema>
}
export function parsePublisherOutbound(input: string | ArrayBuffer | Uint8Array) {
  return parseDirection(PublisherOutboundSchema, input) as InferOutput<typeof PublisherOutboundSchema>
}
export function parseViewerOutbound(input: string | ArrayBuffer | Uint8Array) {
  return parseDirection(ViewerOutboundSchema, input) as InferOutput<typeof ViewerOutboundSchema>
}
export function parseSnapshot(value: unknown): AvatarStateSnapshot {
  return parse(AvatarStateSnapshotSchema, value)
}

export function parseBehavior(value: unknown): AvatarBehavior {
  return parse(AvatarBehaviorSchema, value)
}

export function parseOAuthExchangeRequest(value: unknown): OAuthExchangeRequest {
  return parse(OAuthExchangeRequestSchema, value)
}

export function parseViewerClaims(value: unknown): ViewerClaims {
  return parse(ViewerClaimsSchema, value)
}
