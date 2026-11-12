import type { SocketHandlers, TapeSocket, TapeSocketFactory } from '@/lib/tape-recorder/types';

/** A scripted socket for the tape recorder tests: no network, the test plays the server. */
export class FakeTapeSocket implements TapeSocket {
  sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly handlers: SocketHandlers
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** Parsed JSON of every message sent so far. */
  sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  open(): void {
    this.handlers.onOpen();
  }

  message(data: string | object): void {
    this.handlers.onMessage(typeof data === 'string' ? data : JSON.stringify(data));
  }

  serverClose(code = 1006, reason = ''): void {
    this.handlers.onClose(code, reason);
  }

  error(message = 'boom'): void {
    this.handlers.onError(message);
  }
}

export class FakeTapeSockets {
  sockets: FakeTapeSocket[] = [];

  readonly factory: TapeSocketFactory = (url, handlers) => {
    const socket = new FakeTapeSocket(url, handlers);
    this.sockets.push(socket);
    return socket;
  };

  last(): FakeTapeSocket {
    return this.sockets[this.sockets.length - 1];
  }

  /** Sockets whose URL contains `part`. */
  byUrl(part: string): FakeTapeSocket[] {
    return this.sockets.filter((s) => s.url.includes(part));
  }
}
