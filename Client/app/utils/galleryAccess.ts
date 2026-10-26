// ── Gallery access gate ──
// Playing needs photo permission (full or limited access both count) and at least one image the app can see.
// Checked before creating/joining a room and again whenever the app comes back to the foreground in a room.

export interface GalleryPermission {
  status: "granted" | "denied" | "undetermined" | string;
  canAskAgain: boolean;
  accessPrivileges?: "all" | "limited" | "none";
}

export interface GalleryAccessDeps {
  getPermissions: () => Promise<GalleryPermission>;
  requestPermissions: () => Promise<GalleryPermission>;
  /** Whether at least one image is visible to the app */
  hasPhotos: () => Promise<boolean>;
}

/**
 * "denied": no permission (yet); "no-photos": permission but no image visible to the app; "unavailable": permission
 * but the gallery could not be read (the photo query never answered)
 */
export type GalleryAccessStatus = "ok" | "denied" | "no-photos" | "unavailable";

export interface GalleryAccess {
  status: GalleryAccessStatus;
  /** Only part of the gallery is shared (iOS "Limit access", Android 14+ "Select photos") */
  limited: boolean;
  /** The system permission prompt can still be shown */
  canAskAgain: boolean;
}

/**
 * The photo query can hang without ever answering (seen when the permission is changed while the app runs): past this
 * long the gallery counts as "unavailable", so Create / Join answer with the notice and its Try again instead of hanging.
 */
export const PHOTO_QUERY_TIMEOUT_MS = 5_000;

/** `promise`, or `fallback` if it hasn't settled after `ms` */
const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Current gallery access. With `ask`, the system prompt is shown (once) if it still can be, instead of reporting
 * "denied" straight away.
 */
export const checkGalleryAccess = async (deps: GalleryAccessDeps, { ask }: { ask: boolean }): Promise<GalleryAccess> => {
  let perm = await deps.getPermissions();
  if (perm.status !== "granted" && perm.canAskAgain && ask) perm = await deps.requestPermissions();
  const limited = perm.status === "granted" && perm.accessPrivileges === "limited";
  if (perm.status !== "granted") return { status: "denied", limited: false, canAskAgain: perm.canAskAgain };
  const photos = await withTimeout<boolean | null>(deps.hasPhotos(), PHOTO_QUERY_TIMEOUT_MS, null);
  const status = photos === null ? "unavailable" : photos ? "ok" : "no-photos";
  return { status, limited, canAskAgain: perm.canAskAgain };
};
