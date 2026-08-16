import { HONEYCRISP_PROTOCOL_VERSION } from "./protocol.js";

export const HONEYCRISP_TRANSPORT_PROTOCOL_VERSION = HONEYCRISP_PROTOCOL_VERSION;
export const HONEYCRISP_TRANSPORT_PREFIX = "HONEYCRISP_TRANSPORT ";
export const HONEYCRISP_TRANSPORT_PATH = "/v1/session";

export interface HoneycrispTransportBootstrap {
  protocolVersion: typeof HONEYCRISP_TRANSPORT_PROTOCOL_VERSION;
  transport: "websocket";
  url: string;
  sessionId: string;
}

export interface HoneycrispClientHello {
  protocolVersion: typeof HONEYCRISP_TRANSPORT_PROTOCOL_VERSION;
  type: "client.hello";
  sessionId: string;
  client: { name: string; version: string };
}

export interface HoneycrispServerHello {
  protocolVersion: typeof HONEYCRISP_TRANSPORT_PROTOCOL_VERSION;
  type: "server.hello";
  sessionId: string;
  server: { name: "honeycrisp"; version: string };
  capabilities: readonly ["session.events", "session.controls"];
}

export interface HoneycrispSessionControl<TControl extends Record<string, unknown> = Record<string, unknown>> {
  protocolVersion: typeof HONEYCRISP_TRANSPORT_PROTOCOL_VERSION;
  type: "session.control";
  sessionId: string;
  requestId: string;
  control: TControl;
}

export interface HoneycrispSessionEvent<TEvent extends Record<string, unknown> = Record<string, unknown>> {
  protocolVersion: typeof HONEYCRISP_TRANSPORT_PROTOCOL_VERSION;
  type: "session.event";
  sessionId: string;
  event: TEvent;
}

export interface HoneycrispProtocolError {
  protocolVersion: typeof HONEYCRISP_TRANSPORT_PROTOCOL_VERSION;
  type: "protocol.error";
  sessionId: string;
  message: string;
}

export type HoneycrispClientMessage = HoneycrispClientHello | HoneycrispSessionControl;
export type HoneycrispServerMessage = HoneycrispServerHello | HoneycrispSessionEvent | HoneycrispProtocolError;
