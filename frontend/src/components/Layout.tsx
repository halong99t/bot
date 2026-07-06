import { ReactNode, useState } from "react";
import Sidebar from "./Sidebar";

export default function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar desktop */}
      <div className="hidden md:block">
        <Sidebar />
      </div>

      {/* Sidebar mobile (drawer) */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-0 h-full shadow-2xl">
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <header className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-panel sticky top-0 z-20">
          <button onClick={() => setOpen(true)} className="text-xl leading-none" aria-label="Mở menu">
            ☰
          </button>
          <span className="font-bold text-accent">⚡ Crypto Bot</span>
        </header>

        <main className="flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
