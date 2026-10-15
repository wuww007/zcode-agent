export { RemoteServiceAccess } from "./remoteServiceAccess.js";
export { connectViaProtocol, connectViaWebSocket } from "./websocket.js";
export type { WebSocketConnectionCloseEvent } from "./websocket.js";
export { connectViaMessagePort, createMessagePortServiceConnection } from "./messageport.js";
// Web Remote Control（手机远控）relay 协议：桌面注册设备的帧编解码、ack 化批次与截止时间。
export {
  ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS,
  createAcknowledgedWebRemoteControlRelayProtocol,
  createWebRemoteControlRelayProtocol,
} from "./webRemoteControlRelayProtocol.js";
export type {
  AcknowledgedWebRemoteControlRelayProtocolAdapter,
  AcknowledgedWebRemoteControlRelayProtocolOptions,
  WebRemoteControlRelayProtocolAdapter,
  WebRemoteControlRelayProtocolOptions,
} from "./webRemoteControlRelayProtocol.js";
export * from "./webRemoteControlRelayPayloadSerializer.js";
export type { MessagePortServiceConnection } from "./messageport.js";
