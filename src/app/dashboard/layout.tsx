import Sidebar from "@/components/Sidebar";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-[#0a0b0a]">
      <Sidebar />
      <div className="flex flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
