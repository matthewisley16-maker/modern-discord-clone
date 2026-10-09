import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import { FeatureBoundary } from "@/components/ui/feature-boundary";
import { BrandSplash, DiagnosticsWatcher, GlobalConnectionBanner, ServiceStatusScreen } from "@/components/ServiceStatus";
import { useServiceStatus } from "@/hooks/use-service-status";
import { recordServiceError } from "@/lib/diagnostics";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import "./index.css";

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const AdminPanel = lazy(() => import("./pages/AdminPanel.tsx"));
const Onboarding = lazy(() => import("./pages/Onboarding.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// No visual loading screen anywhere: lazy route chunks resolve into place
// without a spinner or "Loading..." message.
function RouteLoading() {
  return null;
}

/**
 * Root gate: a signed-in visitor lands on the Dashboard immediately, with no
 * landing page flash in between.
 *
 * This used to `return null` while the session resolved, which meant ANY
 * failure to reach the Convex backend (an offline network, or a paused/
 * disabled deployment returning 1013 AuthProviderDiscoveryFailed forever) left
 * a completely black page. Every branch now renders something real:
 *   - resolving   → the branded splash,
 *   - usable      → the product (or the public landing page),
 *   - unusable    → a themed explanation with a guarded Retry, and the public
 *                   landing page is still served when the backend isn't needed.
 */
function RootGate() {
  const { isAuthenticated } = useConvexAuth();
  const handle = useServiceStatus();
  const { status } = handle;

  if (status.phase === "loading") return <BrandSplash />;

  if (status.phase === "ready") {
    return (
      <FeatureBoundary key={handle.retryEpoch} label="Freecord" block>
        {isAuthenticated ? <Dashboard /> : <Landing />}
      </FeatureBoundary>
    );
  }

  // The backend is unreachable. A signed-in user needs the backend, so they get
  // the full explanation. A signed-out visitor does not — keep the public site
  // usable and just explain why sign-in is unavailable.
  if (isAuthenticated) return <ServiceStatusScreen handle={handle} />;

  // The connection banner is rendered globally (GlobalConnectionBanner) so it
  // is not duplicated here; this branch only picks between the explanation
  // screen and the branded splash.
  return status.phase === "unavailable" ? (
    <ServiceStatusScreen handle={handle} />
  ) : (
    <BrandSplash label={status.phase === "offline" ? "Waiting for a network connection…" : "Reconnecting to Freecord…"} />
  );
}

/** `/auth` sends an already signed-in visitor straight to the Dashboard. */
function AuthGate() {
  const { isAuthenticated } = useConvexAuth();
  const handle = useServiceStatus();

  // Still resolving: show the splash rather than nothing.
  if (handle.status.phase === "loading") return <BrandSplash />;
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  // Sign-in needs the backend, but the form stays reachable: it works the
  // moment the connection returns, and never leaves a blank page in the
  // meantime.
  return <AuthPage redirectAfterAuth="/dashboard" />;
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in the browser runtime). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[Preview] Root crash:", err);
    // Feed the diagnostic report so a crash is visible next to connection and
    // auth failures instead of only in the console.
    recordServiceError(err);
  }
  render() {
    if (this.state.hasError) {
      // A runtime error must never leave a blank/black page, and background
      // storage maintenance must NEVER be dressed up as the reason the app is
      // unavailable. This is an honest, retryable message and nothing more.
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Something went wrong</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message || "Freecord couldn't finish loading. Please try again."}
            </p>
            <button
              className="mt-4 rounded-md border border-border px-3 py-1.5 text-xs font-medium"
              onClick={() => window.location.reload()}
            >
              Try again
            </button>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// One Convex deployment for every environment (dev, preview, production).
//
// This used to read `import.meta.env.VITE_CONVEX_URL`, which Vite inlines at
// BUILD time — so a production build could be compiled against a different
// deployment than the one the app is developed against. That split the data:
// the deployed app wrote to a different database than dev, so nothing appeared
// to save. Pinning a single URL here makes dev and the deployed app read and
// write the exact same database, so they stay in sync in real time.
//
// To move to a different deployment, change this one line.
const CONVEX_URL = "https://academic-porcupine-929.convex.cloud";
const convex = new ConvexReactClient(CONVEX_URL);



function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ToolbarErrorBoundary>
        <VlyToolbar />
      </ToolbarErrorBoundary>
      <ConvexAuthProvider client={convex}>
        <BrowserRouter>
          <DiagnosticsWatcher />
          <GlobalConnectionBanner />
          <RouteSyncer />
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path="/" element={<RootGate />} />
              <Route path="/auth" element={<AuthGate />} />
              <Route
                path="/onboarding"
                element={
                  <RequireAuth redirectImmediately>
                    <Onboarding />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard"
                element={
                  <RequireAuth redirectImmediately>
                    <FeatureBoundary label="The dashboard" block>
                      <Dashboard />
                    </FeatureBoundary>
                  </RequireAuth>
                }
              />
              {/* Private Admin Panel — access is enforced again on the server. */}
              <Route
                path="/admin"
                element={
                  <RequireAuth redirectImmediately>
                    <FeatureBoundary label="The Admin Panel" block>
                      <AdminPanel />
                    </FeatureBoundary>
                  </RequireAuth>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster theme="dark" />
      </ConvexAuthProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
