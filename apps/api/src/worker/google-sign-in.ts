import { createSessionCodec, createSignedStateCodec } from "../runtime-security.ts";
import { HttpError } from "../http-error.ts";
import { type AuthMode, type Env, type Role, cookie, requireDatabase, requireRole, writeAudit } from "./core.ts";
import { googleCredentials, googleRedirectUri, integrationErrorRedirect, markIntegrationVerified } from "./integration-support.ts";

export async function googleStart(request: Request, env: Env): Promise<Response> {
  if (!env.SESSION_KEY) throw new HttpError(503, "Authentication is not configured");
  const verification = new URL(request.url).searchParams.get("verify") === "1";
  const reauthentication = new URL(request.url).searchParams.get("reauth") === "modules";
  const reauthenticating = reauthentication ? await requireRole(request, env, ["admin"]) : undefined;
  if (verification) await requireRole(request, env, ["admin"]);
  const installation = await requireDatabase(env).prepare("SELECT auth_mode AS authMode FROM installations WHERE id = 'primary'").first<{ authMode: AuthMode }>();
  if (!installation || !["google", "both"].includes(installation.authMode)) throw new HttpError(404, "Google sign-in is not enabled");
  const credentials = await googleCredentials(env); const redirectUri = googleRedirectUri(env);
  const state = await createSignedStateCodec(env.SESSION_KEY, "google_sign_in").issue();
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.search = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, prompt: "select_account" }).toString();
  const headers = new Headers({ location: target.toString(), "cache-control": "no-store" });
  headers.append("set-cookie", `lancerlogin_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  if (verification) headers.append("set-cookie", "lancerlogin_oauth_verify=1; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600");
  // The callback arrives cross-site without the Strict session cookie; it must sign in the same Admin to count.
  if (reauthenticating) headers.append("set-cookie", `lancerlogin_oauth_reauth=${encodeURIComponent(reauthenticating.userId)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  return new Response(null, { status: 302, headers });
}
const googleOAuthCookies = ["lancerlogin_oauth_state", "lancerlogin_oauth_verify", "lancerlogin_oauth_reauth"];
const googleVerificationAdminMessage = "Verify Google with an active Admin account whose LancerLogin email matches this Google account.";
export async function googleCallback(request: Request, env: Env): Promise<Response> {
  // Only the Integrations verification flow returns errors to the dashboard; normal sign-in keeps its JSON errors.
  if (cookie(request, "lancerlogin_oauth_verify") !== "1") return completeGoogleSignIn(request, env, false);
  try { return await completeGoogleSignIn(request, env, true); }
  catch (error) { if (error instanceof HttpError) return integrationErrorRedirect(env, "google", error.message, googleOAuthCookies); throw error; }
}
async function completeGoogleSignIn(request: Request, env: Env, verification: boolean): Promise<Response> {
  if (!env.SESSION_KEY) throw new HttpError(503, "Authentication is not configured");
  const url = new URL(request.url); if (verification && url.searchParams.get("error")) throw new HttpError(400, "Google sign-in was cancelled or denied. Try verifying Google again.");
  const code = url.searchParams.get("code"); const state = url.searchParams.get("state"); const savedState = cookie(request, "lancerlogin_oauth_state");
  if (!code || !state || state !== savedState || !await createSignedStateCodec(env.SESSION_KEY, "google_sign_in").verify(state)) throw new HttpError(400, "Google sign-in state is invalid or expired");
  const credentials = await googleCredentials(env); const redirectUri = googleRedirectUri(env);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: credentials.clientId, client_secret: credentials.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }) });
  const tokens = await tokenResponse.json() as { id_token?: string }; if (!tokenResponse.ok || !tokens.id_token) throw new HttpError(401, "Google did not accept the sign-in response");
  const validationResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`, { headers: { accept: "application/json" } });
  const profile = await validationResponse.json() as { aud?: string; email?: string; email_verified?: string; iss?: string };
  if (!validationResponse.ok || profile.aud !== credentials.clientId || profile.email_verified !== "true" || !profile.email || !["https://accounts.google.com", "accounts.google.com"].includes(profile.iss ?? "")) throw new HttpError(401, "Google identity validation failed");
  const user = await requireDatabase(env).prepare("SELECT id, role, session_epoch AS sessionEpoch FROM users WHERE installation_id = 'primary' AND email = ? AND active = 1").bind(profile.email.toLowerCase()).first<{ id: string; role: Role; sessionEpoch?: number }>();
  if (verification && user?.role !== "admin") throw new HttpError(403, googleVerificationAdminMessage);
  if (!user) throw new HttpError(403, "This Google account is not an active LancerLogin user");
  const reauthenticating = cookie(request, "lancerlogin_oauth_reauth");
  if (reauthenticating && (decodeURIComponent(reauthenticating) !== user.id || user.role !== "admin")) throw new HttpError(403, "Sign in with the same Admin Google account to confirm your identity");
  // Only an Admin's sign-in proves the Google setup; an Operator still signs in but never marks the integration verified.
  if (user.role === "admin") await markIntegrationVerified(requireDatabase(env), "google", user.id, { email: profile.email.toLowerCase() });
  if (reauthenticating) await writeAudit(requireDatabase(env), { userId: user.id, role: user.role, expiresAt: 0 }, "auth.reauthenticated", "user", user.id, { method: "google", purpose: "plugin_management" });
  const session = await createSessionCodec(env.SESSION_KEY).issue({ userId: user.id, role: user.role, epoch: Number(user.sessionEpoch ?? 0) });
  const headers = new Headers({ location: reauthenticating ? `${env.ALLOWED_ORIGIN}/settings/modules?reauthenticated=1` : verification ? `${env.ALLOWED_ORIGIN}/settings/integrations?verified=google` : env.ALLOWED_ORIGIN, "cache-control": "no-store" });
  headers.append("set-cookie", `lancerlogin_session=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
  headers.append("set-cookie", "lancerlogin_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  headers.append("set-cookie", "lancerlogin_oauth_verify=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  headers.append("set-cookie", "lancerlogin_oauth_reauth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers });
}
