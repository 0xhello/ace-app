import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getUserCount } from "@/lib/auth-db";
import SetupForm from "./SetupForm";

export default async function SetupPage() {
  // Already logged in — nothing to set up
  const session = await auth();
  if (session) redirect("/dashboard");

  // Any error from getUserCount() returns null — treat as "users exist" → safe default
  const count = getUserCount();
  if (count !== 0) redirect("/login");

  return <SetupForm />;
}
