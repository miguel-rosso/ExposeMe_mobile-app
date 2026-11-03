// ── Fake XMLHttpRequest ──
// Jest's Node environment has no XMLHttpRequest. This records every request (one per network download) and lets a
// test answer it: respond() with a status and a fake native blob (arrive() first to stop just before its load event),
// fail() it as a network error, or stall() it to let its timeout run out.

import { NativeModules } from "react-native";

/** Like React Native's Blob: `data` locates its bytes in the native blob store. */
export interface FakeBlob {
  size: number;
  type: string;
  data: { blobId: string; offset: number };
  close: jest.Mock;
}

/** The blob id of every fake response, and the URI an <Image> reads that blob from on iOS. */
export const FAKE_BLOB_ID = "photo-1";
export const FAKE_BLOB_URI = `blob:${FAKE_BLOB_ID}?offset=0&size=1024`;

export class FakeXhr {
  static requests: FakeXhr[] = [];
  static readonly OPENED = 1;
  static readonly LOADING = 3;
  static readonly DONE = 4;

  readyState = 0;
  method = "";
  url = "";
  responseType = "";
  timeout = 0;
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
    const blob: FakeBlob = { size: 1024, type: "image/jpeg", data: { blobId: FAKE_BLOB_ID, offset: 0 }, close: jest.fn() };
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

  /**
   * The network sends nothing for `ms`. Like React Native's native request timeout (an idle timeout: iOS's
   * NSURLRequest.timeoutInterval), a stall at least as long as `timeout` ends the request with a timeout event; with
   * no timeout (0) the request just keeps waiting.
   */
  stall(ms: number) {
    if (this.timeout <= 0 || ms < this.timeout) return;
    this.readyState = FakeXhr.DONE;
    this.ontimeout?.();
  }
}

/** What Expo's URL.createObjectURL throws on the app's bridgeless runtime (proven in photoLoading.test, EXP-404). */
export const EXPO_BRIDGELESS_CREATE_OBJECT_URL_ERROR = "globalThis.__turboModuleProxy is not a function";

/**
 * Installs FakeXhr as the global XMLHttpRequest, in the blob runtime the app has on iOS: React Native's iOS blob module
 * constants (`blob:` URIs, no host) and Expo's URL.createObjectURL, which always throws there. Returns a function that
 * restores all three.
 */
export const installFakeXhr = (): (() => void) => {
  const realXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  const realCreateObjectURL = URL.createObjectURL;
  const blobConstants = jest
    .spyOn(NativeModules.BlobModule, "getConstants")
    .mockReturnValue({ BLOB_URI_SCHEME: "blob", BLOB_URI_HOST: null });
  FakeXhr.requests = [];
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  URL.createObjectURL = jest.fn(() => {
    throw new TypeError(EXPO_BRIDGELESS_CREATE_OBJECT_URL_ERROR);
  });
  return () => {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = realXhr;
    URL.createObjectURL = realCreateObjectURL;
    blobConstants.mockRestore();
  };
};
