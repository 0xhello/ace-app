import { auth } from "@/auth";
import { redirect } from "next/navigation";
import SettingsClient from "./SettingsClient";

export default async function SettingsPage() {
  const session = await auth();
  if (!session) redirect("/login");

  return (
    <SettingsClient
      email={session.user?.email ?? ""}
      role={(session.user as { role?: string }).role ?? "user"}
    />
  );
}
