/** Host-only composition API. Importing this entry does not connect or install a channel. */
export { adaptLarkChannelPort } from './host/channel-attribution.ts'
export { createLarkButlerIntegration } from './host/lark-integration.ts'
export type { LarkButlerContext, LarkButlerPort, LarkButlerIntegrationOptions, LarkReadMessage } from './host/lark-integration.ts'
export { ChannelIngress, ChannelIngressError } from './host/channel-ingress.ts'
export type { ChannelBinding, ChannelOrigin, ChannelIngressOptions, ChannelReceiveResult, LarkInbound } from './host/channel-ingress.ts'
