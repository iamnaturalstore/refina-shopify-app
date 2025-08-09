// app/utils/session.server.js
import { createCookieSessionStorage } from "@remix-run/node";

export const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__session",
    secrets: [process.env.SESSION_SECRET || "default-secret"],
    sameSite: "lax",
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  },
});

export function getSession(cookieHeader) {
  return sessionStorage.getSession(cookieHeader);
}

export function commitSession(session) {
  return sessionStorage.commitSession(session);
}

