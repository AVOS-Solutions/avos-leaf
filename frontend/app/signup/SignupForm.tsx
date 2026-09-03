"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Input, Label } from "@/components/ui";

export function SignupForm() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    const response = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, fullName, licenseKey }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);

    if (!response.ok) {
      setError(body.message ?? "Sign up failed.");
      return;
    }

    router.push("/documents");
    router.refresh();
  }

  return (
    <Card className="w-full max-w-sm">
      <p className="eyebrow mb-1">AVOS Leaf</p>
      <h1 className="mb-2 text-2xl">Set up your account</h1>
      <p className="mb-6 text-sm text-ink-soft">Enter your Leaf license key to create your account and activate it.</p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label htmlFor="licenseKey">License key</Label>
          <Input
            id="licenseKey"
            required
            autoFocus
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
            className="mono"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
          />
        </div>
        <div>
          <Label htmlFor="fullName">Full name</Label>
          <Input id="fullName" required value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate">At least 10 characters.</p>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Creating account…" : "Create account"}
        </Button>
        <p className="text-center text-xs text-slate">
          Already have an account?{" "}
          <Link href="/login" className="transition-colors text-signal-dim no-underline hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </Card>
  );
}
