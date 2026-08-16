import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { PassThrough } from "node:stream";
import type { ResearchLiveEventSink } from "@honeycrisp/research-agent";
import {
  HONEYCRISP_PROTOCOL_MAX_REQUEST_ID_LENGTH,
  HONEYCRISP_PROTOCOL_WEBSOCKET_PATH,
  decodeHoneycrispClientMessage,
  honeycrispServerHello,
  honeycrispSessionEvent,
  honeycrispTransportBootstrap,
  honeycrispWebSocketProtocolError,
  type HoneycrispClientMessage,
  type HoneycrispServerMessage,
  type HoneycrispTransportBootstrap,
} from "./protocol.js";

const MAX_PAYLOAD_BYTES = 1_048_576;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

interface WebSocketConnection {
  readonly readyState: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: () => void): this;
}

interface WebSocketServerInstance {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (connection: WebSocketConnection) => void,
  ): void;
  emit(event: "connection", connection: WebSocketConnection, request: IncomingMessage): boolean;
  on(
    event: "connection",
    listener: (connection: WebSocketConnection, request: IncomingMessage) => void,
  ): this;
  close(callback: () => void): void;
}

interface WebSocketServerConstructor {
  new(options: { noServer: true; maxPayload: number }): WebSocketServerInstance;
}

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as { WebSocketServer: WebSocketServerConstructor };

export interface HoneycrispWebSocketTransportOptions {
  sessionId: string;
  token: string;
  serverVersion: string;
  handshakeTimeoutMs?: number;
}

export class HoneycrispWebSocketTransport {
  public readonly controlInput = new PassThrough();
  public readonly eventSink: ResearchLiveEventSink;
  public readonly bootstrap: HoneycrispTransportBootstrap;

  private client: WebSocketConnection | undefined;
  private ready = false;
  private closing = false;
  private handshakeResolve: (() => void) | undefined;
  private handshakeReject: ((error: Error) => void) | undefined;
  private readonly handshake: Promise<void>;

  private constructor(
    private readonly options: HoneycrispWebSocketTransportOptions,
    private readonly httpServer: HttpServer,
    private readonly webSocketServer: WebSocketServerInstance,
    port: number,
  ) {
    this.bootstrap = honeycrispTransportBootstrap(
      `ws://127.0.0.1:${port}${HONEYCRISP_PROTOCOL_WEBSOCKET_PATH}`,
      options.sessionId,
    );
    this.handshake = new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
    });
    this.eventSink = (event) => this.send(honeycrispSessionEvent(
      this.options.sessionId,
      event as unknown as Record<string, unknown>,
    ));
    this.webSocketServer.on("connection", (connection) => this.acceptClient(connection));
  }

  public static async listen(
    options: HoneycrispWebSocketTransportOptions,
  ): Promise<HoneycrispWebSocketTransport> {
    if (!options.sessionId.trim()) throw new Error("WebSocket transport requires a session ID.");
    if (!options.token.trim()) throw new Error("WebSocket transport requires HONEYCRISP_TRANSPORT_TOKEN.");

    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    const httpServer = createServer((_request, response) => {
      response.writeHead(426, { connection: "close", "content-type": "text/plain" });
      response.end("WebSocket upgrade required.\n");
    });
    httpServer.on("upgrade", (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== HONEYCRISP_PROTOCOL_WEBSOCKET_PATH) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      if (!authorized(request.headers.authorization, options.token)) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (connection) => {
        webSocketServer.emit("connection", connection, request);
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      await closeHttpServer(httpServer);
      throw new Error("Honeycrisp WebSocket transport did not receive a TCP address.");
    }
    return new HoneycrispWebSocketTransport(options, httpServer, webSocketServer, address.port);
  }

  public async waitForClient(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.handshake,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out waiting for a Honeycrisp WebSocket client.")),
            this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  public async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.ready = false;
    this.controlInput.end();
    const client = this.client;
    this.client = undefined;
    client?.close(1000, "session complete");
    await Promise.all([
      new Promise<void>((resolve) => this.webSocketServer.close(resolve)),
      closeHttpServer(this.httpServer),
    ]);
  }

  private acceptClient(connection: WebSocketConnection): void {
    if (this.client) {
      connection.close(1013, "session already has a client");
      return;
    }
    this.client = connection;
    connection.on("message", (data) => this.handleMessage(connection, data));
    connection.on("error", (error) => {
      if (!this.ready) this.handshakeReject?.(error);
    });
    connection.once("close", () => {
      if (this.client !== connection) return;
      this.client = undefined;
      const wasReady = this.ready;
      this.ready = false;
      if (!this.closing && wasReady) {
        this.controlInput.end(`${JSON.stringify({
          schemaVersion: 1,
          type: "stop",
          requestId: "transport_disconnect",
        })}\n`);
      } else if (!this.closing) {
        this.handshakeReject?.(new Error("Honeycrisp WebSocket client disconnected before handshake."));
      }
    });
  }

  private handleMessage(connection: WebSocketConnection, data: unknown): void {
    let raw: unknown;
    try {
      raw = JSON.parse(messageText(data)) as unknown;
    } catch {
      this.protocolError(connection, "invalid_json", "Message must be valid JSON.");
      return;
    }
    let message: HoneycrispClientMessage;
    try {
      message = decodeHoneycrispClientMessage(raw);
    } catch (error) {
      this.protocolError(
        connection,
        "invalid_message",
        error instanceof Error ? error.message : String(error),
        requestIdFromUnknown(raw),
      );
      return;
    }
    if (message.sessionId !== this.options.sessionId) {
      this.protocolError(connection, "session_mismatch", "Session ID mismatch.", requestIdFromMessage(message));
      return;
    }
    if (!this.ready) {
      if (message.type !== "client.hello") {
        this.protocolError(connection, "handshake_required", "The first message must be client.hello.", requestIdFromMessage(message));
        return;
      }
      this.ready = true;
      void this.send(honeycrispServerHello(this.options.sessionId, this.options.serverVersion))
        .then(() => this.handshakeResolve?.(), (error: Error) => this.handshakeReject?.(error));
      return;
    }
    if (message.type !== "session.control") {
      this.protocolError(connection, "unexpected_message", "Expected a session.control message.");
      return;
    }
    this.controlInput.write(`${JSON.stringify(message.control)}\n`, "utf8");
  }

  private protocolError(
    connection: WebSocketConnection,
    code: string,
    message: string,
    requestId?: string,
  ): void {
    connection.send(JSON.stringify(
      honeycrispWebSocketProtocolError(this.options.sessionId, code, message, requestId),
    ));
    connection.close(1002, "protocol error");
  }

  private send(message: HoneycrispServerMessage): Promise<void> {
    const client = this.client;
    if (!client || client.readyState !== 1) {
      return Promise.reject(new Error("Honeycrisp WebSocket client is unavailable."));
    }
    return new Promise((resolve, reject) => {
      client.send(JSON.stringify(message), (error) => error ? reject(error) : resolve());
    });
  }
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data) && data.every((entry) => Buffer.isBuffer(entry))) {
    return Buffer.concat(data).toString("utf8");
  }
  throw new Error("Unsupported WebSocket message payload.");
}

function requestIdFromMessage(message: HoneycrispClientMessage): string | undefined {
  return message.type === "session.control" ? message.requestId : undefined;
}

function requestIdFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string"
    && requestId.trim()
    && requestId.length <= HONEYCRISP_PROTOCOL_MAX_REQUEST_ID_LENGTH
    ? requestId
    : undefined;
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}
