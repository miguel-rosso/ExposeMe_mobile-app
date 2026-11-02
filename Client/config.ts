// EXPO_PUBLIC_SERVER_URL overrides the server for local development / QA lab
// (e.g. http://localhost:3000 with `adb reverse` on Android). Defaults to production.
const PROD_SERVER_URL = "https://exposeme-mobile-app-f72q.onrender.com";

/**
 * Invite links (`<INVITE_BASE_URL>/<room code>`) always point at the production server's join page, even from a QA
 * build: they are meant for other people's phones, which can't reach a local server.
 */
export const INVITE_BASE_URL = `${PROD_SERVER_URL}/join`;

const getEnvVars = () => {
  return {
    SERVER_URL: process.env.EXPO_PUBLIC_SERVER_URL || PROD_SERVER_URL,
  };
};

export default getEnvVars;
