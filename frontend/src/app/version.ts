declare const __PALSERVER_CONSOLE_VERSION__: string;

export const FRONTEND_VERSION =
  typeof __PALSERVER_CONSOLE_VERSION__ === "string" ? __PALSERVER_CONSOLE_VERSION__ : "unavailable";
