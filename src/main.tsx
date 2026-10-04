import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
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
const Onboarding = lazy(() => import("./pages/Onboarding.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// No visual loading screen anywhere: lazy route chunks resolve into place
// without a spinner or "Loading..." message.
function RouteLoading() {
  return null;
}

/**
 * Root gate: a signed-in visitor lands on the Dashboard immediately, with no
 * landing page, sign-in page, spinner or loading screen in between.
 */
function RootGate() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) return null;
  return isAuthenticated ? <Dashboard /> : <Landing />;
}

/** `/auth` sends an already signed-in visitor straight to the Dashboard. */
function AuthGate() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) return null;
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
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
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
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
                    <Dashboard />
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
