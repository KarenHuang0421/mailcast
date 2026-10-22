import { google } from "googleapis";
import type { Config } from "./config.js";

/** OAuth2 client authorized with the stored refresh token (gmail.readonly + drive.file). */
export function googleAuth(config: Config) {
  const client = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET);
  client.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN });
  return client;
}
