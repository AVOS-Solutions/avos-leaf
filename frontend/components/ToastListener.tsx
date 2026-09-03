"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

function ToastListenerInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    const message = searchParams.get("toast");
    if (!message) return;

    const type = searchParams.get("toastType") === "error" ? "error" : "success";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot: promote a toast passed via the URL into local state, then strip the param below.
    setToast({ message, type });

    const params = new URLSearchParams(searchParams.toString());
    params.delete("toast");
    params.delete("toastType");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;

  return (
    <div className="no-print fixed bottom-6 right-6 z-[100]">
      <div
        role="status"
        className={`rounded-lg border px-4 py-3 text-sm shadow-lg ${
          toast.type === "error" ? "border-brass/40 bg-brass text-paper" : "border-line bg-ink text-paper"
        }`}
      >
        {toast.message}
      </div>
    </div>
  );
}

export function ToastListener() {
  return (
    <Suspense fallback={null}>
      <ToastListenerInner />
    </Suspense>
  );
}
