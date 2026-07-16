// Account field constraints, shared by the register endpoint and the admin
// CLI so both paths enforce the same shape (decisions.md §2: on an
// admin-only instance the CLI is how accounts are born).

import { z } from "zod";

export const emailField = z.email().max(254);

export const usernameField = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9_.-]+$/, "letters, digits, and _.- only");

export const passwordField = z.string().min(8).max(128);
