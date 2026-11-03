// ── Fake XMLHttpRequest ──
// Jest's Node environment has no XMLHttpRequest. This records every request (one per network download) and lets a
// test answer it: respond() with a status and a fake native blob (arrive() first to stop just before its load event),
// or fail() it as a network error.

export interface FakeBlob {
  size: number;
  type: string;
  close: jest.Mock;
}

export class FakeXhr {
  static requests: FakeXhr[] = [];
  static readonly OPENED = 1;
  static readonly LOADING = 3;
  static readonly DONE = 4;

  readyState = 0;
  method = "";
  url = "";
  responseType = "";
  headers: Record<string, string> = {};
  status = 0;
  response: unknown = null;
  sent = false;
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.requests.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
    this.readyState = FakeXhr.OPENED;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send() {
    this.sent = true;
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  /** The response has arrived (LOADING), its load event not dispatched yet: React Native has made its native blob. */
  arrive(status = 200): FakeBlob {
    const blob: FakeBlob = { size: 1024, type: "image/jpeg", close: jest.fn() };
    this.readyState = FakeXhr.LOADING;
    this.status = status;
    this.response = blob;
    return blob;
  }

  /** Completes the request: any status comes with a fake native blob as its response, like React Native's. */
  respond(status = 200): FakeBlob {
    const blob = this.readyState === FakeXhr.LOADING ? (this.response as FakeBlob) : this.arrive(status);
    this.readyState = FakeXhr.DONE;
    this.onload?.();
    return blob;
  }

  fail() {
    this.onerror?.();
  }
}

/** Installs FakeXhr as the global XMLHttpRequest and URL.createObjectURL; returns a function that restores both. */
export const installFakeXhr = (blobUri = "blob:photo-1?offset=0&size=1024"): (() => void) => {
  const realXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  const realCreateObjectURL = URL.createObjectURL;
  FakeXhr.requests = [];
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  URL.createObjectURL = jest.fn(() => blobUri);
  return () => {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = realXhr;
    URL.createObjectURL = realCreateObjectURL;
  };
};
