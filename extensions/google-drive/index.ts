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

type GoogleDriveConfig = {
  clientId: string;
  clientSecret: string;
  defaultFolderId: string;
  maxResults: number;
};

// ---------------------------------------------------------------------------
// OAuth constants
// ---------------------------------------------------------------------------

const REDIRECT_URI = "http://localhost:51123/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const RESPONSE_PAGE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenClaw Google Drive OAuth</title>
  </head>
  <body>
    <main>
      <h1>Authentication complete</h1>
      <p>You can return to the terminal.</p>
    </main>
  </body>
</html>`;

// Google Docs export MIME type mapping
const EXPORT_MIME_MAP: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/png",
};

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
  const port = redirect.port ? Number(redirect.port) : 51123;

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

async function loginGoogleDrive(params: {
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
      "Google Drive OAuth",
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

  params.progress.stop("Google Drive OAuth complete");
  return { ...tokens, email };
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const GoogleDriveToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("search_files"),
    query: Type.String({ description: "Drive search query (e.g. \"name contains 'budget'\" or \"fullText contains 'report'\")" }),
    maxResults: Type.Optional(Type.Integer({ description: "Max files to return" })),
  }),
  Type.Object({
    action: Type.Literal("list_files"),
    folderId: Type.Optional(Type.String({ description: "Folder ID to list (default: root)" })),
    maxResults: Type.Optional(Type.Integer({ description: "Max files to return" })),
  }),
  Type.Object({
    action: Type.Literal("get_file"),
    fileId: Type.String({ description: "File ID" }),
  }),
  Type.Object({
    action: Type.Literal("read_file"),
    fileId: Type.String({ description: "File ID to read/download" }),
  }),
  Type.Object({
    action: Type.Literal("create_file"),
    name: Type.String({ description: "File name" }),
    content: Type.String({ description: "File content (text)" }),
    mimeType: Type.Optional(Type.String({ description: "MIME type (default: text/plain)" })),
    parentId: Type.Optional(Type.String({ description: "Parent folder ID" })),
  }),
  Type.Object({
    action: Type.Literal("create_folder"),
    name: Type.String({ description: "Folder name" }),
    parentId: Type.Optional(Type.String({ description: "Parent folder ID" })),
  }),
  Type.Object({
    action: Type.Literal("update_file"),
    fileId: Type.String({ description: "File ID to update" }),
    name: Type.Optional(Type.String({ description: "New file name" })),
    content: Type.Optional(Type.String({ description: "New file content (text)" })),
  }),
  Type.Object({
    action: Type.Literal("share_file"),
    fileId: Type.String({ description: "File ID to share" }),
    email: Type.String({ description: "Email address to share with" }),
    role: Type.Optional(Type.String({ description: "Permission role: reader, commenter, or writer (default: reader)" })),
  }),
  Type.Object({
    action: Type.Literal("delete_file"),
    fileId: Type.String({ description: "File ID to move to trash" }),
  }),
]);

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const FILE_FIELDS = "id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,owners";

const googleDrivePlugin = {
  id: "google-drive",
  name: "Google Drive",
  description: "Google Drive integration with file management, search, read/write, and sharing",
  configSchema: {
    parse(value: unknown): GoogleDriveConfig {
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const clientId = typeof raw.clientId === "string" ? raw.clientId : "";
      const clientSecret = typeof raw.clientSecret === "string" ? raw.clientSecret : "";
      const defaultFolderId =
        typeof raw.defaultFolderId === "string" ? raw.defaultFolderId : "root";
      const maxResults =
        typeof raw.maxResults === "number" ? raw.maxResults : 25;

      return { clientId, clientSecret, defaultFolderId, maxResults };
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
      defaultFolderId: {
        label: "Default Folder ID",
        help: 'Drive folder ID to use when none is specified. Defaults to "root".',
      },
      maxResults: {
        label: "Max Results",
        help: "Maximum number of files returned per request.",
      },
    },
  },
  register(api: OpenClawPluginApi) {
    const config = googleDrivePlugin.configSchema.parse(api.pluginConfig);

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
          "Google Drive is not authenticated. Please run provider setup to complete the OAuth flow.",
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

    async function driveFetch(
      path: string,
      init?: RequestInit,
    ): Promise<unknown> {
      const token = await ensureAccessToken();
      const base = path.startsWith("/upload/") ? UPLOAD_API : DRIVE_API;
      const apiPath = path.startsWith("/upload/") ? path.replace("/upload/", "/") : path;
      const response = await fetch(`${base}${apiPath}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...init?.headers,
        },
      });

      if (response.status === 204) {
        return { success: true };
      }

      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Google Drive API error ${response.status}: ${body}`);
      }
      return JSON.parse(body);
    }

    async function driveFetchRaw(
      path: string,
      init?: RequestInit,
    ): Promise<Response> {
      const token = await ensureAccessToken();
      return fetch(`${DRIVE_API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...init?.headers,
        },
      });
    }

    // -----------------------------------------------------------------------
    // OAuth provider
    // -----------------------------------------------------------------------

    api.registerProvider({
      id: "google-drive",
      label: "Google Drive",
      docsPath: "/extensions/google-drive",
      auth: [
        {
          id: "oauth",
          label: "Google OAuth",
          hint: "PKCE + localhost callback",
          kind: "oauth",
          run: async (ctx: ProviderAuthContext) => {
            if (!config.clientId || !config.clientSecret) {
              throw new Error(
                "Google Drive plugin requires clientId and clientSecret in config.",
              );
            }

            const spin = ctx.prompter.progress("Starting Google Drive OAuth…");
            try {
              const result = await loginGoogleDrive({
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

              const profileId = `google-drive:${result.email ?? "default"}`;
              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "oauth" as const,
                      provider: "google-drive",
                      access: result.access,
                      refresh: result.refresh,
                      expires: result.expires,
                      clientId: config.clientId,
                      email: result.email,
                    },
                  },
                ],
                notes: [
                  "Google Drive connected successfully.",
                  "Make sure the Google Drive API is enabled in your Google Cloud project.",
                ],
              };
            } catch (err) {
              spin.stop("Google Drive OAuth failed");
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
      name: "google_drive",
      label: "Google Drive",
      description:
        "Manage Google Drive files: search, list, read, create, update, share, and delete files and folders.",
      parameters: GoogleDriveToolSchema,
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const action = (params as Record<string, unknown>).action as string;

          switch (action) {
            case "search_files": {
              const p = params as { query: string; maxResults?: number };
              const qs = new URLSearchParams();
              qs.set("q", p.query);
              qs.set("fields", `files(${FILE_FIELDS})`);
              qs.set("pageSize", String(p.maxResults ?? config.maxResults));
              const data = await driveFetch(`/files?${qs}`);
              return json(data);
            }

            case "list_files": {
              const p = params as { folderId?: string; maxResults?: number };
              const folderId = p.folderId || config.defaultFolderId;
              const qs = new URLSearchParams();
              qs.set("q", `'${folderId}' in parents and trashed = false`);
              qs.set("fields", `files(${FILE_FIELDS})`);
              qs.set("pageSize", String(p.maxResults ?? config.maxResults));
              qs.set("orderBy", "modifiedTime desc");
              const data = await driveFetch(`/files?${qs}`);
              return json(data);
            }

            case "get_file": {
              const p = params as { fileId: string };
              const qs = new URLSearchParams();
              qs.set("fields", FILE_FIELDS);
              const data = await driveFetch(
                `/files/${encodeURIComponent(p.fileId)}?${qs}`,
              );
              return json(data);
            }

            case "read_file": {
              const p = params as { fileId: string };

              // First get file metadata to determine type
              const metaQs = new URLSearchParams();
              metaQs.set("fields", "id,name,mimeType,size");
              const meta = (await driveFetch(
                `/files/${encodeURIComponent(p.fileId)}?${metaQs}`,
              )) as { mimeType?: string; name?: string };

              const mimeType = meta.mimeType ?? "";
              const exportMime = EXPORT_MIME_MAP[mimeType];

              let response: Response;
              if (exportMime) {
                // Google Workspace file — use export
                const qs = new URLSearchParams();
                qs.set("mimeType", exportMime);
                response = await driveFetchRaw(
                  `/files/${encodeURIComponent(p.fileId)}/export?${qs}`,
                );
              } else {
                // Binary/regular file — download content
                response = await driveFetchRaw(
                  `/files/${encodeURIComponent(p.fileId)}?alt=media`,
                );
              }

              if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Download failed ${response.status}: ${errText}`);
              }

              const text = await response.text();
              return json({ name: meta.name, mimeType, content: text });
            }

            case "create_file": {
              const p = params as {
                name: string;
                content: string;
                mimeType?: string;
                parentId?: string;
              };
              const metadata: Record<string, unknown> = { name: p.name };
              if (p.parentId) {
                metadata.parents = [p.parentId];
              }

              const boundary = "openclaw_boundary_" + randomBytes(8).toString("hex");
              const fileMime = p.mimeType || "text/plain";

              const multipartBody = [
                `--${boundary}`,
                "Content-Type: application/json; charset=UTF-8",
                "",
                JSON.stringify(metadata),
                `--${boundary}`,
                `Content-Type: ${fileMime}`,
                "",
                p.content,
                `--${boundary}--`,
              ].join("\r\n");

              const token = await ensureAccessToken();
              const qs = new URLSearchParams();
              qs.set("uploadType", "multipart");
              qs.set("fields", FILE_FIELDS);

              const response = await fetch(`${UPLOAD_API}/files?${qs}`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": `multipart/related; boundary=${boundary}`,
                },
                body: multipartBody,
              });

              if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Upload failed ${response.status}: ${errText}`);
              }
              const data = await response.json();
              return json(data);
            }

            case "create_folder": {
              const p = params as { name: string; parentId?: string };
              const metadata: Record<string, unknown> = {
                name: p.name,
                mimeType: "application/vnd.google-apps.folder",
              };
              if (p.parentId) {
                metadata.parents = [p.parentId];
              }
              const qs = new URLSearchParams();
              qs.set("fields", FILE_FIELDS);
              const data = await driveFetch(`/files?${qs}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(metadata),
              });
              return json(data);
            }

            case "update_file": {
              const p = params as {
                fileId: string;
                name?: string;
                content?: string;
              };

              if (p.content !== undefined) {
                // Update content using multipart upload
                const metadata: Record<string, unknown> = {};
                if (p.name !== undefined) metadata.name = p.name;

                const boundary = "openclaw_boundary_" + randomBytes(8).toString("hex");
                const multipartBody = [
                  `--${boundary}`,
                  "Content-Type: application/json; charset=UTF-8",
                  "",
                  JSON.stringify(metadata),
                  `--${boundary}`,
                  "Content-Type: text/plain",
                  "",
                  p.content,
                  `--${boundary}--`,
                ].join("\r\n");

                const token = await ensureAccessToken();
                const qs = new URLSearchParams();
                qs.set("uploadType", "multipart");
                qs.set("fields", FILE_FIELDS);

                const response = await fetch(
                  `${UPLOAD_API}/files/${encodeURIComponent(p.fileId)}?${qs}`,
                  {
                    method: "PATCH",
                    headers: {
                      Authorization: `Bearer ${token}`,
                      "Content-Type": `multipart/related; boundary=${boundary}`,
                    },
                    body: multipartBody,
                  },
                );

                if (!response.ok) {
                  const errText = await response.text();
                  throw new Error(`Update failed ${response.status}: ${errText}`);
                }
                const data = await response.json();
                return json(data);
              }

              // Metadata-only update
              const metadata: Record<string, unknown> = {};
              if (p.name !== undefined) metadata.name = p.name;
              const qs = new URLSearchParams();
              qs.set("fields", FILE_FIELDS);
              const data = await driveFetch(
                `/files/${encodeURIComponent(p.fileId)}?${qs}`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(metadata),
                },
              );
              return json(data);
            }

            case "share_file": {
              const p = params as {
                fileId: string;
                email: string;
                role?: string;
              };
              const permission = {
                type: "user",
                role: p.role || "reader",
                emailAddress: p.email,
              };
              const data = await driveFetch(
                `/files/${encodeURIComponent(p.fileId)}/permissions`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(permission),
                },
              );
              return json(data);
            }

            case "delete_file": {
              const p = params as { fileId: string };
              // Move to trash instead of permanent delete
              const data = await driveFetch(
                `/files/${encodeURIComponent(p.fileId)}`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ trashed: true }),
                },
              );
              return json({ trashed: true, fileId: p.fileId, ...((data as Record<string, unknown>) ?? {}) });
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

export default googleDrivePlugin;
