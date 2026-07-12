import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { IdentityPicker } from "./components/auth/IdentityPicker.js";
import { Login } from "./components/auth/Login.js";
import { Register } from "./components/auth/Register.js";
import { Landing } from "./components/landing/Landing.js";
import { AppPlaceholder } from "./components/shell/AppPlaceholder.js";
import { useAuthStore } from "./stores/auth.js";

function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  if (status === "restoring") {
    return null; // boot revalidation — resolved within one round trip
  }
  if (status !== "authenticated") {
    return <Navigate to="/login" replace />;
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
        <Route
          path="/app/:identityId?"
          element={
            <RequireAuth>
              <AppPlaceholder />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
