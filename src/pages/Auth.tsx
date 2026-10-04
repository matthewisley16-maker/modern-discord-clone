import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/convex/_generated/api";
import { useAction } from "convex/react";
import { toast } from "sonner";
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
  const resetPassword = useAction(api.passwords.resetPassword);

  // Primary method is username + password. Email code sign-in stays available.
  const [method, setMethod] = useState<"username" | "email">("username");
  const [mode, setMode] = useState<"signIn" | "signUp" | "forgot">("signIn");
  const [showEmail, setShowEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  // Email OTP flow state
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");
  // After recovering via email code, the user is signed back into the SAME
  // account and prompted to set a new password before continuing.
  const [resetPending, setResetPending] = useState(false);
  const [resetPw, setResetPw] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetBusy, setResetBusy] = useState(false);

  useEffect(() => {
    if (!authLoading && isAuthenticated && !resetPending) navigate(redirect);
  }, [authLoading, isAuthenticated, navigate, redirect, resetPending]);

  const usernameOk = USERNAME_RE.test(username.trim().toLowerCase());
  const passwordOk = password.length >= 8 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
  const resetOk = resetPw.length >= 8 && /[a-zA-Z]/.test(resetPw) && /[0-9]/.test(resetPw);
  const resetMatch = resetPw.length > 0 && resetPw === resetConfirm;

  function resetMessages() {
    setError(null);
    setNotice(null);
  }

  function friendly(err: unknown, fallback: string) {
    const raw = err instanceof Error ? err.message : fallback;
    return raw.split("\n")[0].replace(/^.*Error:\s*/, "").slice(0, 200);
  }

  // --- Username + password (no email required) ---
  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
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
        const identifier = username.trim().toLowerCase();
        // Accept either a username or an email. Unknown identifiers fail with
        // the same generic error, so email addresses can't be enumerated.
        if (identifier.includes("@")) {
          await signIn("email-password", { email: identifier, password });
        } else {
          await signIn("password", { flow: "signIn", username: identifier, password });
        }
        navigate(redirect);
      }
    } catch (err) {
      setError(friendly(err, "Something went wrong."));
    } finally {
      setBusy(false);
    }
  }

  // --- Email sign-in: send a one-time code ---
  async function sendEmailCode(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    setBusy(true);
    try {
      await signIn("email-otp", { email: email.trim().toLowerCase() });
      setOtpSent(true);
      setNotice(`We've sent a 6-digit code to ${email.trim().toLowerCase()}.`);
    } catch (err) {
      setError(friendly(err, "Could not send the code. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  // --- Email sign-in: verify the code ---
  async function verifyEmailCode(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    setBusy(true);
    try {
      await signIn("email-otp", { email: email.trim().toLowerCase(), code: otp });
      // Recovery: the code signs us back into the same account. Offer a new
      // password instead of jumping straight to the app.
      if (mode === "forgot") {
        setResetPending(true);
        setResetPw("");
        setResetConfirm("");
      } else {
        navigate(redirect);
      }
    } catch (err) {
      setError(friendly(err, "That code isn't correct."));
      setOtp("");
    } finally {
      setBusy(false);
    }
  }

  async function requestReset(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    setBusy(true);
    try {
      await signIn("email-otp", { email: email.trim().toLowerCase() });
      setMethod("email");
      setOtpSent(true);
      setNotice("If that email is linked to an account, we've sent a recovery code.");
    } catch {
      setNotice("If that email is linked to an account, we've sent a recovery code.");
    } finally {
      setBusy(false);
    }
  }

  // Step 3 of recovery: set a new password on the SAME account (already signed in
  // via the email code) without ever creating a second user.
  async function submitResetPassword(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    if (!resetOk) { setError("Password must be at least 8 characters and include a letter and a number."); return; }
    if (!resetMatch) { setError("Those passwords don't match."); return; }
    setResetBusy(true);
    try {
      await resetPassword({ newPassword: resetPw });
      toast.success("Password updated. You're signed in.");
      setResetPending(false);
      navigate(redirect);
    } catch (err) {
      setError(friendly(err, "Could not update your password."));
    } finally {
      setResetBusy(false);
    }
  }

  const heading =
    resetPending ? "Set a new password"
      : method === "email"
        ? otpSent ? "Enter your code" : "Sign in with email"
        : mode === "signUp" ? "Create your Freecord account"
          : mode === "forgot" ? "Account recovery"
            : "Welcome back";

  const subheading =
    resetPending ? "Choose a new password for your existing account."
      : method === "email"
        ? otpSent ? `We sent a code to ${email.trim().toLowerCase()}.` : "We'll email you a one-time sign-in code."
        : mode === "signUp" ? "All you need is a username and password. Email is optional."
          : mode === "forgot" ? "Recovery needs a verified email on your account."
            : "Sign in with your username or email and password.";

  return (
    <div className="auth-freecord min-h-screen flex flex-col">
      <div className="flex-1 flex items-center justify-center">
        <Card className="min-w-[350px] pb-0 border shadow-md">
          <CardHeader className="text-center">
            <div className="flex justify-center">
              <button type="button" aria-label="Freecord home" onClick={() => navigate("/")}><FreecordMark /></button>
            </div>
            <CardTitle className="text-xl">{heading}</CardTitle>
            <CardDescription>{subheading}</CardDescription>
          </CardHeader>

          {/* Method switch: username/password vs email code */}
          {!resetPending && !(method === "email" && otpSent) && mode !== "forgot" && (
            <div className="mx-6 mb-4 grid grid-cols-2 gap-1 rounded-lg border border-border/70 p-1">
              <button
                type="button"
                className={`rounded-md px-3 py-2 text-xs font-medium transition ${method === "username" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => { setMethod("username"); resetMessages(); }}
              >
                <User className="mr-1 inline h-3.5 w-3.5" /> Username
              </button>
              <button
                type="button"
                className={`rounded-md px-3 py-2 text-xs font-medium transition ${method === "email" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => { setMethod("email"); setMode("signIn"); resetMessages(); }}
              >
                <Mail className="mr-1 inline h-3.5 w-3.5" /> Email code
              </button>
            </div>
          )}

          {/* ---------- Recovery step 3: choose a new password ---------- */}
          {resetPending ? (
            <form onSubmit={submitResetPassword}>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  You&apos;re signed back into your account. Choose a new password to continue.
                </p>
                <div className="relative">
                  <ShieldCheck className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="password"
                    autoComplete="new-password"
                    className="pl-9"
                    placeholder="New password"
                    value={resetPw}
                    onChange={(e) => setResetPw(e.target.value)}
                    disabled={resetBusy}
                    required
                  />
                </div>
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Confirm new password"
                  value={resetConfirm}
                  onChange={(e) => setResetConfirm(e.target.value)}
                  disabled={resetBusy}
                  required
                />
                <p className="text-xs text-muted-foreground">At least 8 characters, with one letter and one number.</p>
                {resetConfirm.length > 0 && !resetMatch && <p className="text-xs text-destructive">Those passwords don&apos;t match.</p>}
                {error && <p className="text-sm text-destructive">{error}</p>}
              </CardContent>
              <CardFooter className="flex-col gap-2">
                <Button type="submit" className="w-full" disabled={resetBusy || !resetOk || !resetMatch}>
                  {resetBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                  Update password
                </Button>
                <Button type="button" variant="ghost" className="w-full" disabled={resetBusy} onClick={() => { setResetPending(false); navigate(redirect); }}>
                  Skip for now
                </Button>
              </CardFooter>
            </form>
          ) : method === "email" && otpSent ? (
            <form onSubmit={verifyEmailCode}>
              <CardContent className="space-y-4 pb-4">
                <div className="flex justify-center">
                  <InputOTP
                    value={otp}
                    onChange={setOtp}
                    maxLength={6}
                    disabled={busy}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && otp.length === 6 && !busy) {
                        (e.target as HTMLElement).closest("form")?.requestSubmit();
                      }
                    }}
                  >
                    <InputOTPGroup>
                      {Array.from({ length: 6 }).map((_, i) => <InputOTPSlot key={i} index={i} />)}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                {notice && <p className="text-center text-xs text-muted-foreground">{notice}</p>}
                {error && <p className="text-center text-sm text-destructive">{error}</p>}
              </CardContent>
              <CardFooter className="flex-col gap-2">
                <Button type="submit" className="w-full" disabled={busy || otp.length !== 6}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
                  Verify code
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => { setOtpSent(false); setOtp(""); resetMessages(); }} disabled={busy}>
                  Use a different email
                </Button>
              </CardFooter>
            </form>
          ) : method === "email" ? (
            /* ---------- Email code: request step ---------- */
            <form onSubmit={sendEmailCode}>
              <CardContent className="space-y-3">
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
                <p className="text-xs text-muted-foreground">
                  Email sign-in works for accounts that have an email linked. If you signed up with
                  only a username, use the Username tab.
                </p>
                {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
                {error && <p className="text-sm text-destructive">{error}</p>}
              </CardContent>
              <CardFooter className="flex-col gap-2">
                <Button type="submit" className="w-full" disabled={busy || !email.trim()}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
                  Email me a sign-in code
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => { setMethod("username"); resetMessages(); }}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back to username sign in
                </Button>
              </CardFooter>
            </form>
          ) : mode === "forgot" ? (
            /* ---------- Forgot password ---------- */
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
                <Button type="button" variant="ghost" className="w-full" onClick={() => { setMode("signIn"); resetMessages(); }}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back to sign in
                </Button>
              </CardFooter>
            </form>
          ) : (
            /* ---------- Username + password ---------- */
            <form onSubmit={submitCredentials}>
              <CardContent className="space-y-3">
                <div className="relative">
                  <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    name="username"
                    autoComplete="username"
                    className="pl-9"
                    placeholder={mode === "signUp" ? "username" : "username or email"}
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
                  <Input
                    placeholder="Display name (optional)"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    disabled={busy}
                    maxLength={40}
                  />
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
                    {showEmail ? (
                      <>
                        <Input
                          type="email"
                          placeholder="you@example.com"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          disabled={busy}
                        />
                        <p className="text-xs text-muted-foreground">
                          An email lets you recover your account and sign in with an email code. You
                          can add or change it later in Settings.
                        </p>
                      </>
                    ) : (
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
                  onClick={() => { setMode(mode === "signUp" ? "signIn" : "signUp"); resetMessages(); }}
                >
                  {mode === "signUp" ? "I already have an account" : "Create an account"}
                </Button>
                {mode === "signIn" && (
                  <Button type="button" variant="link" className="w-full text-xs" onClick={() => { setMode("forgot"); resetMessages(); }}>
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
