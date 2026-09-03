"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";
import { Button, Card, Input, Label } from "@/components/ui";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  const next = searchParams.get("next") ?? "/documents";
  const ssoError = searchParams.get("error") === "sso_failed";

  function goToNext() {
    router.push(next);
    router.refresh();
  }

  async function handlePasswordSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    setIsSubmitting(false);
    const body = await response.json().catch(() => ({ message: "Login failed." }));

    if (!response.ok) {
      setError(body.message ?? "Login failed.");
      return;
    }

    if (body.requiresTwoFactor) {
      setChallengeToken(body.challengeToken);
      return;
    }

    goToNext();
  }

  async function handleCodeSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const response = await fetch("/api/auth/2fa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeToken, code }),
    });

    setIsSubmitting(false);
    const body = await response.json().catch(() => ({ message: "Invalid or expired code." }));

    if (!response.ok) {
      setError(body.message ?? "Invalid or expired code.");
      return;
    }

    goToNext();
  }

  if (challengeToken) {
    return (
      <Card className="w-full max-w-sm">
        <p className="eyebrow mb-1">AVOS Leaf</p>
        <h1 className="mb-2 text-2xl">Two-factor code</h1>
        <p className="mb-6 text-sm text-ink-soft">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
        <form onSubmit={handleCodeSubmit} className="space-y-4">
          <div>
            <Label htmlFor="code">Code</Label>
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-brass">{error}</p>}
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Verifying…" : "Verify"}
          </Button>
          <button
            type="button"
            className="transition-colors w-full text-center text-xs text-slate hover:text-ink-soft"
            onClick={() => {
              setChallengeToken(null);
              setCode("");
              setError(null);
            }}
          >
            Back to password
          </button>
        </form>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <p className="eyebrow mb-1">AVOS Leaf</p>
      <h1 className="mb-6 text-2xl">Sign in</h1>

      {ssoError && (
        <p className="mb-4 text-sm text-brass">Sign-in didn&apos;t complete. Please try again.</p>
      )}

      {!showPasswordForm ? (
        <div className="space-y-4">
          <a href={`/api/auth/sso/start?next=${encodeURIComponent(next)}`}>
            <Button type="button" className="w-full">
              Sign in with AVOS
            </Button>
          </a>
          <p className="text-center text-xs text-slate">
            You&apos;ll be sent to avos-licensing to sign in — no separate password for avos-leaf.
          </p>
          <button
            type="button"
            className="transition-colors w-full text-center text-xs text-slate hover:text-ink-soft"
            onClick={() => setShowPasswordForm(true)}
          >
            Use email and password instead
          </button>
          <p className="text-center text-xs text-slate">
            Have a Leaf license key?{" "}
            <Link href="/signup" className="transition-colors text-signal-dim no-underline hover:underline">
              Set up your account
            </Link>
          </p>
        </div>
      ) : (
        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-brass">{error}</p>}
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Signing in…" : "Sign in"}
          </Button>
          <button
            type="button"
            className="transition-colors w-full text-center text-xs text-slate hover:text-ink-soft"
            onClick={() => setShowPasswordForm(false)}
          >
            Back to &quot;Sign in with AVOS&quot;
          </button>
          <p className="text-center text-xs text-slate">
            Have a Leaf license key?{" "}
            <Link href="/signup" className="transition-colors text-signal-dim no-underline hover:underline">
              Set up your account
            </Link>
          </p>
        </form>
      )}
    </Card>
  );
}
