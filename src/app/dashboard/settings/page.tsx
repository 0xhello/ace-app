import { auth } from "@/auth";
import { redirect } from "next/navigation";
import SettingsClient from "./SettingsClient";
import { devSession, isLocalAuthBypassEnabled } from "@/lib/dev-auth";

export default async function SettingsPage() {
  const session = isLocalAuthBypassEnabled ? devSession : await auth();
  if (!session) redirect("/login");

  return (
    <SettingsClient
      email={session.user?.email ?? ""}
      role={(session.user as { role?: string }).role ?? "user"}
    />
  );
}
