import type { SocketHandlers, TapeSocket, TapeSocketFactory } from './types';

/** The slice of the WHATWG WebSocket the tape recorder uses; Node 22's global and the test mock both fit. */
export interface TapeWebSocketLike {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: string): void;
  close(): void;
}

export type TapeWebSocketConstructor = new (url: string) => TapeWebSocketLike;

function errorText(ev: unknown): string {
  if (ev && typeof ev === 'object' && 'message' in ev) {
    const message = (ev as { message: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'websocket error';
}

/** Adapts a WebSocket constructor to the handler-style factory the feeds use. */
export function tapeSocketFactory(Ctor: TapeWebSocketConstructor): TapeSocketFactory {
  return (url: string, handlers: SocketHandlers): TapeSocket => {
    const ws = new Ctor(url);
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (ev) => handlers.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
    ws.onclose = (ev) => {
      const { code, reason } = (ev ?? {}) as { code?: unknown; reason?: unknown };
      handlers.onClose(typeof code === 'number' ? code : null, typeof reason === 'string' ? reason : '');
    };
    ws.onerror = (ev) => handlers.onError(errorText(ev));
    return {
      send(data) {
        ws.send(data);
      },
      close() {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          // Already closing or closed.
        }
      },
    };
  };
}
