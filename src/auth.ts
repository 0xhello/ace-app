import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { authConfig } from "@/auth.config";
import { getUserByEmail, ensureAuthSchema } from "@/lib/auth-db";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        ensureAuthSchema();
        const user = getUserByEmail(credentials.email as string);
        if (!user) return null;
        const valid = await bcrypt.compare(
          credentials.password as string,
          user.password_hash
        );
        if (!valid) return null;
        return { id: String(user.id), email: user.email, role: user.role };
      },
    }),
  ],
});
