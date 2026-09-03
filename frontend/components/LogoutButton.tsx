"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      className="transition mono text-xs text-slate hover:text-signal-dim disabled:opacity-50"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          router.push("/login");
          router.refresh();
        })
      }
    >
      {isPending ? "Signing out…" : "Sign out"}
    </button>
  );
}
