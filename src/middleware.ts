import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

const OPS_READ_TOKEN_HEADER = "x-ops-read-token";

function hasValidOpsReadToken(req: Request): boolean {
  const configuredToken = process.env.OPS_READ_TOKEN?.trim();
  const providedToken = req.headers.get(OPS_READ_TOKEN_HEADER)?.trim();

  return !!configuredToken && !!providedToken && providedToken === configuredToken;
}

export default auth(function middleware(req) {
  const { nextUrl } = req;
  const isLoggedIn = !!req.auth;
  const role = (req.auth?.user as { role?: string } | undefined)?.role;

  // API ops routes — return 401 for non-admin (don't redirect, it's an API).
  // Read-only machine access is allowed for GET requests carrying OPS_READ_TOKEN.
  // Mutating routes (POST/PUT/PATCH/DELETE) still require an admin session.
  if (nextUrl.pathname.startsWith("/api/ops/")) {
    if (req.method === "GET" && hasValidOpsReadToken(req)) {
      return;
    }

    if (!isLoggedIn || role !== "admin") {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return;
  }

  // Ops dashboard — redirect non-admin to unauthorized page
  if (nextUrl.pathname.startsWith("/dashboard/ops")) {
    if (!isLoggedIn) {
      return Response.redirect(new URL("/login", nextUrl));
    }
    if (role !== "admin") {
      return Response.redirect(new URL("/unauthorized", nextUrl));
    }
    return;
  }

  // All other dashboard routes — require login
  if (nextUrl.pathname.startsWith("/dashboard")) {
    if (!isLoggedIn) {
      return Response.redirect(new URL("/login", nextUrl));
    }
    return;
  }
});

export const config = {
  matcher: ["/dashboard/:path*", "/api/ops/:path*"],
};
