import type { ReactNode } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router";
import { IdentityPicker } from "./components/auth/IdentityPicker.js";
import { Login } from "./components/auth/Login.js";
import { Register } from "./components/auth/Register.js";
import { Landing } from "./components/landing/Landing.js";
import { AppShell } from "./components/shell/AppShell.js";
import { useAuthStore } from "./stores/auth.js";

function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();
  if (status === "restoring") {
    return null; // boot revalidation — resolved within one round trip
  }
  if (status !== "authenticated") {
    // Carry the deep link through the redirect; Login resumes it.
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }
  return children;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="/identities"
          element={
            <RequireAuth>
              <IdentityPicker />
            </RequireAuth>
          }
        />
        {/* Human-readable app routes (M3): identity by character name (or
            @me / a legacy UUID), conversation by channel key or DM partner.
            The two-segment form catches old UUID conversation links, which
            AppShell redirects to their canonical name-based path. */}
        <Route
          path="/app/:identity"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        />
        <Route
          path="/app/:identity/c/:channel"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        />
        <Route
          path="/app/:identity/dm/:partner"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        />
        <Route
          path="/app/:identity/:legacyConvId"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
