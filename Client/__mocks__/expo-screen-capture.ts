// jest-expo's native-module mock returns no usable subscription from addListener; the real API returns one with
// remove(). Tests that need to fire screenshots override this with their own jest.mock.
export const addScreenshotListener = jest.fn(() => ({ remove: jest.fn() }));
export const preventScreenCaptureAsync = jest.fn(async () => {});
export const allowScreenCaptureAsync = jest.fn(async () => {});
