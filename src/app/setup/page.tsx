import { redirect } from "next/navigation";
import { getUserCount } from "@/lib/auth-db";
import SetupForm from "./SetupForm";

export default function SetupPage() {
  const count = getUserCount();
  if (count > 0) {
    redirect("/login");
  }
  return <SetupForm />;
}
