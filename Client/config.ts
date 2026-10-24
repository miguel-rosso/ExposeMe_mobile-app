// EXPO_PUBLIC_SERVER_URL overrides the server for local development / QA lab
// (e.g. http://localhost:3000 with `adb reverse` on Android). Defaults to production.
const PROD_SERVER_URL = "https://exposeme-mobile-app-f72q.onrender.com";

const getEnvVars = () => {
  return {
    SERVER_URL: process.env.EXPO_PUBLIC_SERVER_URL || PROD_SERVER_URL,
  };
};

export default getEnvVars;
