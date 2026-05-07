import { redirect } from "next/navigation";
import { auth } from "@/auth";
import Sidebar from "@/components/Sidebar";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect("/login");

  const role = (session.user as { role?: string }).role ?? "user";
  const email = session.user?.email ?? "";

  return (
    <div className="flex h-screen overflow-hidden bg-[#0a0b0a]">
      <Sidebar role={role} email={email} />
      <div className="flex flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
