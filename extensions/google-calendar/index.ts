import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Type } from "@sinclair/typebox";
import {
  isWSL2Sync,
  type OpenClawPluginApi,
  type ProviderAuthContext,
} from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

type GoogleCalendarConfig = {
  clientId: string;
  clientSecret: string;
  defaultCalendarId: string;
  maxResults: number;
  timeZone?: string;
};

// ---------------------------------------------------------------------------
// OAuth constants
// ---------------------------------------------------------------------------

const REDIRECT_URI = "http://localhost:51122/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const RESPONSE_PAGE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenClaw Google Calendar OAuth</title>
  </head>
  <body>
    <main>
      <h1>Authentication complete</h1>
      <p>You can return to the terminal.</p>
    </main>
  </body>
</html>`;

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthUrl(params: {
  clientId: string;
  challenge: string;
  state: string;
}): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

function parseCallbackInput(input: string): { code: string; state: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "No input provided" };
  }
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) {
      return { error: "Missing 'code' parameter in URL" };
    }
    if (!state) {
      return { error: "Missing 'state' parameter in URL" };
    }
    return { code, state };
  } catch {
    return { error: "Paste the full redirect URL (not just the code)." };
  }
}

// ---------------------------------------------------------------------------
// Callback server
// ---------------------------------------------------------------------------

async function startCallbackServer(params: { timeoutMs: number }) {
  const redirect = new URL(REDIRECT_URI);
  const port = redirect.port ? Number(redirect.port) : 51122;

  let settled = false;
  let resolveCallback: (url: URL) => void;
  let rejectCallback: (err: Error) => void;

  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCallback = (url) => {
      if (settled) return;
      settled = true;
      resolve(url);
    };
    rejectCallback = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
  });

  const timeout = setTimeout(() => {
    rejectCallback(new Error("Timed out waiting for OAuth callback"));
  }, params.timeoutMs);
  timeout.unref?.();

  const server = createServer((request, response) => {
    if (!request.url) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Missing URL");
      return;
    }

    const url = new URL(request.url, `${redirect.protocol}//${redirect.host}`);
    if (url.pathname !== redirect.pathname) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(RESPONSE_PAGE);
    resolveCallback(url);

    setImmediate(() => {
      server.close();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  return {
    waitForCallback: () => callbackPromise,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Token exchange & user info
// ---------------------------------------------------------------------------

async function exchangeCode(params: {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ access: string; refresh: string; expires: number }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code_verifier: params.verifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${text}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const access = data.access_token?.trim();
  const refresh = data.refresh_token?.trim();
  const expiresIn = data.expires_in ?? 0;

  if (!access) {
    throw new Error("Token exchange returned no access_token");
  }
  if (!refresh) {
    throw new Error("Token exchange returned no refresh_token");
  }

  const expires = Date.now() + expiresIn * 1000 - 5 * 60 * 1000;
  return { access, refresh, expires };
}

async function refreshAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ access: string; expires: number }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      refresh_token: params.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed: ${text}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  const access = data.access_token?.trim();
  if (!access) {
    throw new Error("Token refresh returned no access_token");
  }

  const expires = Date.now() + (data.expires_in ?? 0) * 1000 - 5 * 60 * 1000;
  return { access, expires };
}

async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { email?: string };
    return data.email;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

async function loginGoogleCalendar(params: {
  clientId: string;
  clientSecret: string;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  prompt: (message: string) => Promise<string>;
  note: (message: string, title?: string) => Promise<void>;
  log: (message: string) => void;
  progress: { update: (msg: string) => void; stop: (msg?: string) => void };
}): Promise<{
  access: string;
  refresh: string;
  expires: number;
  email?: string;
}> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const authUrl = buildAuthUrl({ clientId: params.clientId, challenge, state });

  const needsManual = params.isRemote || isWSL2Sync();
  let callbackServer: Awaited<ReturnType<typeof startCallbackServer>> | null = null;

  if (!needsManual) {
    try {
      callbackServer = await startCallbackServer({ timeoutMs: 5 * 60 * 1000 });
    } catch {
      callbackServer = null;
    }
  }

  if (!callbackServer) {
    await params.note(
      [
        "Open the URL in your local browser.",
        "After signing in, copy the full redirect URL and paste it back here.",
        "",
        `Auth URL: ${authUrl}`,
        `Redirect URI: ${REDIRECT_URI}`,
      ].join("\n"),
      "Google Calendar OAuth",
    );
    params.log("");
    params.log("Copy this URL:");
    params.log(authUrl);
    params.log("");
  }

  if (!needsManual) {
    params.progress.update("Opening Google sign-in…");
    try {
      await params.openUrl(authUrl);
    } catch {
      // ignore
    }
  }

  let code = "";
  let returnedState = "";

  if (callbackServer) {
    params.progress.update("Waiting for OAuth callback…");
    const callback = await callbackServer.waitForCallback();
    code = callback.searchParams.get("code") ?? "";
    returnedState = callback.searchParams.get("state") ?? "";
    await callbackServer.close();
  } else {
    params.progress.update("Waiting for redirect URL…");
    const input = await params.prompt("Paste the redirect URL: ");
    const parsed = parseCallbackInput(input);
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    code = parsed.code;
    returnedState = parsed.state;
  }

  if (!code) {
    throw new Error("Missing OAuth code");
  }
  if (returnedState !== state) {
    throw new Error("OAuth state mismatch. Please try again.");
  }

  params.progress.update("Exchanging code for tokens…");
  const tokens = await exchangeCode({
    code,
    verifier,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
  });
  const email = await fetchUserEmail(tokens.access);

  params.progress.stop("Google Calendar OAuth complete");
  return { ...tokens, email };
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const GoogleCalendarToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("list_calendars"),
  }),
  Type.Object({
    action: Type.Literal("list_events"),
    calendarId: Type.Optional(Type.String({ description: "Calendar ID (default: primary)" })),
    timeMin: Type.Optional(Type.String({ description: "Start of time range (ISO 8601)" })),
    timeMax: Type.Optional(Type.String({ description: "End of time range (ISO 8601)" })),
    maxResults: Type.Optional(Type.Integer({ description: "Max events to return" })),
  }),
  Type.Object({
    action: Type.Literal("search_events"),
    query: Type.String({ description: "Free-text search query" }),
    calendarId: Type.Optional(Type.String({ description: "Calendar ID (default: primary)" })),
    timeMin: Type.Optional(Type.String({ description: "Start of time range (ISO 8601)" })),
    timeMax: Type.Optional(Type.String({ description: "End of time range (ISO 8601)" })),
    maxResults: Type.Optional(Type.Integer({ description: "Max events to return" })),
  }),
  Type.Object({
    action: Type.Literal("get_event"),
    eventId: Type.String({ description: "Event ID" }),
    calendarId: Type.Optional(Type.String({ description: "Calendar ID (default: primary)" })),
  }),
  Type.Object({
    action: Type.Literal("create_event"),
    summary: Type.String({ description: "Event title" }),
    start: Type.String({ description: "Start date/time (YYYY-MM-DD for all-day, ISO 8601 for timed)" }),
    end: Type.String({ description: "End date/time (YYYY-MM-DD for all-day, ISO 8601 for timed)" }),
    calendarId: Type.Optional(Type.String({ description: "Calendar ID (default: primary)" })),
    description: Type.Optional(Type.String({ description: "Event description" })),
    location: Type.Optional(Type.String({ description: "Event location" })),
    attendees: Type.Optional(Type.Array(Type.String({ description: "Attendee email" }))),
    timeZone: Type.Optional(Type.String({ description: "IANA time zone for the event" })),
  }),
  Type.Object({
    action: Type.Literal("update_event"),
    eventId: Type.String({ description: "Event ID" }),
    calendarId: Type.Optional(Type.String({ description: "Calendar ID (default: primary)" })),
    summary: Type.Optional(Type.String({ description: "New event title" })),
    start: Type.Optional(Type.String({ description: "New start date/time" })),
    end: Type.Optional(Type.String({ description: "New end date/time" })),
    description: Type.Optional(Type.String({ description: "New event description" })),
    location: Type.Optional(Type.String({ description: "New event location" })),
    attendees: Type.Optional(Type.Array(Type.String({ description: "Attendee email" }))),
    timeZone: Type.Optional(Type.String({ description: "IANA time zone for the event" })),
  }),
  Type.Object({
    action: Type.Literal("delete_event"),
    eventId: Type.String({ description: "Event ID" }),
    calendarId: Type.Optional(Type.String({ description: "Calendar ID (default: primary)" })),
  }),
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAllDayDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function buildDateParam(
  value: string,
  timeZone?: string,
): { date: string } | { dateTime: string; timeZone?: string } {
  if (isAllDayDate(value)) {
    return { date: value };
  }
  return timeZone ? { dateTime: value, timeZone } : { dateTime: value };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const googleCalendarPlugin = {
  id: "google-calendar",
  name: "Google Calendar",
  description: "Google Calendar integration with full CRUD operations",
  configSchema: {
    parse(value: unknown): GoogleCalendarConfig {
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const clientId = typeof raw.clientId === "string" ? raw.clientId : "";
      const clientSecret = typeof raw.clientSecret === "string" ? raw.clientSecret : "";
      const defaultCalendarId =
        typeof raw.defaultCalendarId === "string" ? raw.defaultCalendarId : "primary";
      const maxResults =
        typeof raw.maxResults === "number" ? raw.maxResults : 25;
      const timeZone =
        typeof raw.timeZone === "string" ? raw.timeZone : undefined;

      return { clientId, clientSecret, defaultCalendarId, maxResults, timeZone };
    },
    uiHints: {
      clientId: {
        label: "Google OAuth Client ID",
        help: "OAuth 2.0 client ID from your Google Cloud project.",
      },
      clientSecret: {
        label: "Google OAuth Client Secret",
        sensitive: true,
      },
      defaultCalendarId: {
        label: "Default Calendar ID",
        help: 'Calendar ID to use when none is specified. Defaults to "primary".',
      },
      maxResults: {
        label: "Max Results",
        help: "Maximum number of events returned per request.",
      },
      timeZone: {
        label: "Time Zone",
        help: "IANA time zone (e.g. America/New_York). Uses calendar default if omitted.",
        advanced: true,
      },
    },
  },
  register(api: OpenClawPluginApi) {
    const config = googleCalendarPlugin.configSchema.parse(api.pluginConfig);

    // Token state managed in closure
    let accessToken = "";
    let refreshToken = "";
    let tokenExpires = 0;

    async function ensureAccessToken(): Promise<string> {
      if (accessToken && Date.now() < tokenExpires) {
        return accessToken;
      }
      if (!refreshToken) {
        throw new Error(
          "Google Calendar is not authenticated. Please run provider setup to complete the OAuth flow.",
        );
      }
      const refreshed = await refreshAccessToken({
        refreshToken,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      });
      accessToken = refreshed.access;
      tokenExpires = refreshed.expires;
      return accessToken;
    }

    async function calendarFetch(
      path: string,
      init?: RequestInit,
    ): Promise<unknown> {
      const token = await ensureAccessToken();
      const response = await fetch(`${CALENDAR_API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...init?.headers,
        },
      });

      if (response.status === 204) {
        return { success: true };
      }

      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Google Calendar API error ${response.status}: ${body}`);
      }
      return JSON.parse(body);
    }

    // -----------------------------------------------------------------------
    // OAuth provider
    // -----------------------------------------------------------------------

    api.registerProvider({
      id: "google-calendar",
      label: "Google Calendar",
      docsPath: "/extensions/google-calendar",
      auth: [
        {
          id: "oauth",
          label: "Google OAuth",
          hint: "PKCE + localhost callback",
          kind: "oauth",
          run: async (ctx: ProviderAuthContext) => {
            if (!config.clientId || !config.clientSecret) {
              throw new Error(
                "Google Calendar plugin requires clientId and clientSecret in config.",
              );
            }

            const spin = ctx.prompter.progress("Starting Google Calendar OAuth…");
            try {
              const result = await loginGoogleCalendar({
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                isRemote: ctx.isRemote,
                openUrl: ctx.openUrl,
                prompt: async (message) => String(await ctx.prompter.text({ message })),
                note: ctx.prompter.note,
                log: (message) => ctx.runtime.log(message),
                progress: spin,
              });

              // Store tokens in closure for tool use
              accessToken = result.access;
              refreshToken = result.refresh;
              tokenExpires = result.expires;

              const profileId = `google-calendar:${result.email ?? "default"}`;
              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "oauth" as const,
                      provider: "google-calendar",
                      access: result.access,
                      refresh: result.refresh,
                      expires: result.expires,
                      clientId: config.clientId,
                      email: result.email,
                    },
                  },
                ],
                notes: [
                  "Google Calendar connected successfully.",
                  "Make sure the Google Calendar API is enabled in your Google Cloud project.",
                ],
              };
            } catch (err) {
              spin.stop("Google Calendar OAuth failed");
              throw err;
            }
          },
        },
      ],
      refreshOAuth: async (cred) => {
        const cId = cred.clientId || config.clientId;
        if (!cId || !config.clientSecret || !cred.refresh) {
          return cred;
        }
        const refreshed = await refreshAccessToken({
          refreshToken: cred.refresh,
          clientId: cId,
          clientSecret: config.clientSecret,
        });

        // Update closure tokens
        accessToken = refreshed.access;
        tokenExpires = refreshed.expires;

        return {
          ...cred,
          access: refreshed.access,
          expires: refreshed.expires,
        };
      },
    });

    // -----------------------------------------------------------------------
    // Tool
    // -----------------------------------------------------------------------

    api.registerTool({
      name: "google_calendar",
      label: "Google Calendar",
      description:
        "Manage Google Calendar events: list calendars, list/search/get/create/update/delete events.",
      parameters: GoogleCalendarToolSchema,
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const calId = (params as Record<string, unknown>).calendarId as string | undefined;
          const calendarId = calId || config.defaultCalendarId;
          const action = (params as Record<string, unknown>).action as string;

          switch (action) {
            case "list_calendars": {
              const data = await calendarFetch("/users/me/calendarList");
              return json(data);
            }

            case "list_events": {
              const p = params as {
                timeMin?: string;
                timeMax?: string;
                maxResults?: number;
              };
              const qs = new URLSearchParams();
              qs.set("singleEvents", "true");
              qs.set("orderBy", "startTime");
              qs.set("maxResults", String(p.maxResults ?? config.maxResults));
              if (p.timeMin) qs.set("timeMin", p.timeMin);
              if (p.timeMax) qs.set("timeMax", p.timeMax);
              if (config.timeZone) qs.set("timeZone", config.timeZone);
              const data = await calendarFetch(
                `/calendars/${encodeURIComponent(calendarId)}/events?${qs}`,
              );
              return json(data);
            }

            case "search_events": {
              const p = params as {
                query: string;
                timeMin?: string;
                timeMax?: string;
                maxResults?: number;
              };
              const qs = new URLSearchParams();
              qs.set("q", p.query);
              qs.set("singleEvents", "true");
              qs.set("orderBy", "startTime");
              qs.set("maxResults", String(p.maxResults ?? config.maxResults));
              if (p.timeMin) qs.set("timeMin", p.timeMin);
              if (p.timeMax) qs.set("timeMax", p.timeMax);
              if (config.timeZone) qs.set("timeZone", config.timeZone);
              const data = await calendarFetch(
                `/calendars/${encodeURIComponent(calendarId)}/events?${qs}`,
              );
              return json(data);
            }

            case "get_event": {
              const p = params as { eventId: string };
              const data = await calendarFetch(
                `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(p.eventId)}`,
              );
              return json(data);
            }

            case "create_event": {
              const p = params as {
                summary: string;
                start: string;
                end: string;
                description?: string;
                location?: string;
                attendees?: string[];
                timeZone?: string;
              };
              const tz = p.timeZone || config.timeZone;
              const body: Record<string, unknown> = {
                summary: p.summary,
                start: buildDateParam(p.start, tz),
                end: buildDateParam(p.end, tz),
              };
              if (p.description) body.description = p.description;
              if (p.location) body.location = p.location;
              if (p.attendees?.length) {
                body.attendees = p.attendees.map((email) => ({ email }));
              }
              const data = await calendarFetch(
                `/calendars/${encodeURIComponent(calendarId)}/events`,
                { method: "POST", body: JSON.stringify(body) },
              );
              return json(data);
            }

            case "update_event": {
              const p = params as {
                eventId: string;
                summary?: string;
                start?: string;
                end?: string;
                description?: string;
                location?: string;
                attendees?: string[];
                timeZone?: string;
              };
              const tz = p.timeZone || config.timeZone;
              const body: Record<string, unknown> = {};
              if (p.summary !== undefined) body.summary = p.summary;
              if (p.start !== undefined) body.start = buildDateParam(p.start, tz);
              if (p.end !== undefined) body.end = buildDateParam(p.end, tz);
              if (p.description !== undefined) body.description = p.description;
              if (p.location !== undefined) body.location = p.location;
              if (p.attendees !== undefined) {
                body.attendees = p.attendees.map((email) => ({ email }));
              }
              const data = await calendarFetch(
                `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(p.eventId)}`,
                { method: "PATCH", body: JSON.stringify(body) },
              );
              return json(data);
            }

            case "delete_event": {
              const p = params as { eventId: string };
              await calendarFetch(
                `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(p.eventId)}`,
                { method: "DELETE" },
              );
              return json({ deleted: true, eventId: p.eventId });
            }

            default:
              return json({ error: `Unknown action: ${action}` });
          }
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });
  },
};

export default googleCalendarPlugin;
