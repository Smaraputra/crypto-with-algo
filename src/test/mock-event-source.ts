type EventHandler = ((event: Event) => void) | null;
type MessageHandler = ((event: MessageEvent) => void) | null;

interface ListenerRecord {
  raw: unknown;
  fn: (event: Event) => void;
}

export class MockEventSource implements EventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  static instances: MockEventSource[] = [];
  static lastInstance: MockEventSource | null = null;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;

  url: string;
  withCredentials = false;
  readyState: number = MockEventSource.CONNECTING;
  closed = false;

  onopen: EventHandler = null;
  onmessage: MessageHandler = null;
  onerror: EventHandler = null;

  private listeners: Map<string, ListenerRecord[]> = new Map();

  constructor(url: string | URL, _eventSourceInitDict?: EventSourceInit) {
    void _eventSourceInitDict;
    this.url = typeof url === 'string' ? url : url.toString();
    MockEventSource.instances.push(this);
    MockEventSource.lastInstance = this;
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ((event: MessageEvent) => void) | null,
    _options?: boolean | AddEventListenerOptions
  ): void {
    void _options;
    if (!listener) return;
    const fn =
      typeof listener === 'function'
        ? (listener as (event: Event) => void)
        : (event: Event) => listener.handleEvent(event);
    const list = this.listeners.get(type) ?? [];
    list.push({ raw: listener, fn });
    this.listeners.set(type, list);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ((event: MessageEvent) => void) | null,
    _options?: boolean | EventListenerOptions
  ): void {
    void _options;
    if (!listener) return;
    const list = this.listeners.get(type);
    if (!list) return;
    const next = list.filter((item) => item.raw !== listener);
    if (next.length === 0) {
      this.listeners.delete(type);
    } else {
      this.listeners.set(type, next);
    }
  }

  dispatchEvent(event: Event): boolean {
    const list = this.listeners.get(event.type);
    if (list) {
      for (const item of list) {
        item.fn(event);
      }
    }
    return true;
  }

  close(): void {
    if (this.readyState === MockEventSource.CLOSED) return;
    this.readyState = MockEventSource.CLOSED;
    this.closed = true;
  }

  simulateOpen(): void {
    this.readyState = MockEventSource.OPEN;
    const event = new Event('open');
    this.onopen?.(event);
    this.dispatchEvent(event);
  }

  simulateMessage(data: unknown): void {
    const event = new MessageEvent('message', {
      data: typeof data === 'string' ? data : JSON.stringify(data),
    });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  simulateEvent(type: string, data?: unknown): void {
    const event = new MessageEvent(type, {
      data: data !== undefined ? (typeof data === 'string' ? data : JSON.stringify(data)) : '{}',
    });
    this.dispatchEvent(event);
  }

  simulateError({ closed = false }: { closed?: boolean } = {}): void {
    if (closed) {
      this.readyState = MockEventSource.CLOSED;
      this.closed = true;
    } else {
      this.readyState = MockEventSource.CONNECTING;
    }
    const event = new Event('error');
    this.onerror?.(event);
    this.dispatchEvent(event);
  }

  static resetMock(): void {
    MockEventSource.instances = [];
    MockEventSource.lastInstance = null;
  }
}
