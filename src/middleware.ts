import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

export default auth(function middleware(req) {
  const { nextUrl } = req;
  const isLoggedIn = !!req.auth;
  const role = (req.auth?.user as { role?: string } | undefined)?.role;

  // API ops routes — return 401 for non-admin (don't redirect, it's an API)
  if (nextUrl.pathname.startsWith("/api/ops/")) {
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
