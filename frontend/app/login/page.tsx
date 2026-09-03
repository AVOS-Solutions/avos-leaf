import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-6">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
