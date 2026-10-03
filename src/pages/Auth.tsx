import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { FreecordMark } from "./Landing";
import { ArrowLeft, ArrowRight, Check, Loader2, Mail, ShieldCheck, User } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

interface AuthProps { redirectAfterAuth?: string }

function resolveRedirect(returnTo: string | null, fallback = "/dashboard") {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) return returnTo;
  return fallback;
}

const USERNAME_RE = /^[a-z0-9._]{3,24}$/;

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirect(searchParams.get("returnTo"), redirectAfterAuth);

  const [mode, setMode] = useState<"signIn" | "signUp" | "forgot">("signIn");
  const [showEmail, setShowEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (!authLoading && isAuthenticated) navigate(redirect);
  }, [authLoading, isAuthenticated, navigate, redirect]);

  const usernameOk = USERNAME_RE.test(username.trim().toLowerCase());
  const passwordOk = password.length >= 8 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === "signUp") {
        await signIn("password", {
          flow: "signUp",
          username: username.trim().toLowerCase(),
          password,
          displayName: displayName.trim() || username.trim().toLowerCase(),
          ...(showEmail && email.trim() ? { email: email.trim().toLowerCase() } : {}),
        });
        navigate("/onboarding");
      } else {
        await signIn("password", {
          flow: "signIn",
          username: username.trim().toLowerCase(),
          password,
        });
        navigate(redirect);
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Something went wrong.";
      // Keep server messages user-safe and strip stack noise.
      setError(raw.split("\n")[0].replace(/^.*Error:\s*/, "").slice(0, 200));
    } finally {
      setBusy(false);
    }
  }

  async function requestReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // Recovery requires a verified email. We never claim a password can be
      // recovered without one.
      await signIn("email-otp", { email: email.trim().toLowerCase() });
      setNotice("If that email is linked to an account, we've sent a recovery code.");
    } catch {
      setNotice("If that email is linked to an account, we've sent a recovery code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-freecord min-h-screen flex flex-col">
      <div className="flex-1 flex items-center justify-center">
        <Card className="min-w-[350px] pb-0 border shadow-md">
          <CardHeader className="text-center">
            <div className="flex justify-center">
              <button type="button" aria-label="Freecord home" onClick={() => navigate("/")}><FreecordMark /></button>
            </div>
            <CardTitle className="text-xl">
              {mode === "signUp" ? "Create your Freecord account" : mode === "forgot" ? "Account recovery" : "Welcome back"}
            </CardTitle>
            <CardDescription>
              {mode === "signUp"
                ? "All you need is a username and password. Email is optional."
                : mode === "forgot"
                  ? "Recovery needs a verified email on your account."
                  : "Sign in with your username and password."}
            </CardDescription>
          </CardHeader>

          {mode === "forgot" ? (
            <form onSubmit={requestReset}>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Freecord accounts don't require an email. If you added one, we can send a recovery
                  code to it. If you didn't, there is no way to recover the password — you can delete
                  the account and create a new one instead.
                </p>
                <div className="relative">
                  <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="email"
                    required
                    className="pl-9"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={busy}
                  />
                </div>
                {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
                {error && <p className="text-sm text-destructive">{error}</p>}
              </CardContent>
              <CardFooter className="flex-col gap-2">
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
                  Send recovery code
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => { setMode("signIn"); setError(null); setNotice(null); }}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back to sign in
                </Button>
              </CardFooter>
            </form>
          ) : (
            <form onSubmit={submit}>
              <CardContent className="space-y-3">
                <div className="relative">
                  <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    name="username"
                    autoComplete="username"
                    className="pl-9"
                    placeholder="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    disabled={busy}
                    required
                  />
                </div>
                {mode === "signUp" && username.length > 0 && !usernameOk && (
                  <p className="text-xs text-destructive">
                    3–24 characters: letters, numbers, dots, and underscores only.
                  </p>
                )}
                {mode === "signUp" && (
                  <div className="relative">
                    <Input
                      placeholder="Display name (optional)"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      disabled={busy}
                      maxLength={40}
                    />
                  </div>
                )}
                <div className="relative">
                  <ShieldCheck className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="password"
                    autoComplete={mode === "signUp" ? "new-password" : "current-password"}
                    className="pl-9"
                    placeholder="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                    required
                  />
                </div>
                {mode === "signUp" && password.length > 0 && !passwordOk && (
                  <p className="text-xs text-destructive">
                    At least 8 characters, with one letter and one number.
                  </p>
                )}

                {mode === "signUp" && (
                  <div className="space-y-2 rounded-md border border-border/70 p-3">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between text-sm"
                      onClick={() => setShowEmail((v) => !v)}
                    >
                      <span className="flex items-center gap-2">
                        <Mail className="h-4 w-4 text-muted-foreground" />
                        Add a recovery email (optional)
                      </span>
                      <span className="text-xs text-muted-foreground">{showEmail ? "Hide" : "Add"}</span>
                    </button>
                    {showEmail && (
                      <>
                        <Input
                          type="email"
                          placeholder="you@example.com"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          disabled={busy}
                        />
                        <p className="text-xs text-muted-foreground">
                          An email lets you recover your account if you forget your password. You can
                          add or change it later in Settings.
                        </p>
                      </>
                    )}
                    {!showEmail && (
                      <p className="text-xs text-muted-foreground">
                        You can create your account without an email and add one later in Settings.
                      </p>
                    )}
                  </div>
                )}

                {error && <p className="text-sm text-destructive">{error}</p>}
              </CardContent>
              <CardFooter className="flex-col gap-2">
                <Button type="submit" className="w-full" disabled={busy || (mode === "signUp" && (!usernameOk || !passwordOk))}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
                  {mode === "signUp" ? "Create account" : "Sign in"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => { setMode(mode === "signUp" ? "signIn" : "signUp"); setError(null); }}
                >
                  {mode === "signUp" ? "I already have an account" : "Create an account"}
                </Button>
                {mode === "signIn" && (
                  <Button type="button" variant="link" className="w-full text-xs" onClick={() => { setMode("forgot"); setError(null); }}>
                    Forgot your password?
                  </Button>
                )}
                {mode === "signUp" && (
                  <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
                    <Check className="h-3 w-3" /> No email required to sign up
                  </p>
                )}
              </CardFooter>
            </form>
          )}

          <div className="py-4 px-6 text-xs text-center text-muted-foreground bg-muted border-t rounded-b-lg">
            A place to talk, connect, and build communities.
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
