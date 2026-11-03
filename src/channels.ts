/**
 * Host-only composition API. Importing this entry does not connect or install a
 * channel: no credential is read, no socket is opened, nothing is sent.
 *
 * A **channel adapter** is a declared contract (`schemaVersion: 1`, see
 * `shared/extension.ts`): `isReady()` reports readiness and
 * `send(destination, payload)` performs delivery for a destination the caller
 * already chose. Adapters are registered at runtime through the
 * `butlerExtensions` service (`docs/extension-api.md`); registration only tells
 * the butler the adapter exists — it does not route traffic through it, choose
 * destinations, grant permissions or take over delivery. The types are
 * re-exported here so an adapter implementation can be typed without importing
 * the whole host entry.
 */
export { adaptLarkChannelPort } from './host/channel-attribution.ts'
export { createLarkButlerIntegration } from './host/lark-integration.ts'
export type { LarkButlerContext, LarkButlerPort, LarkButlerIntegrationOptions, LarkReadMessage } from './host/lark-integration.ts'
export { ChannelIngress, ChannelIngressError } from './host/channel-ingress.ts'
export type { ChannelBinding, ChannelOrigin, ChannelIngressOptions, ChannelReceiveResult, LarkInbound } from './host/channel-ingress.ts'
export type { ButlerChannelAdapter, ChannelDestination, ChannelLimits, ChannelPayload, ChannelSendResult } from './shared/extension.ts'
