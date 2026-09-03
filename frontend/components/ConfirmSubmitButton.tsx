"use client";

import { ButtonHTMLAttributes } from "react";

// A submit button that asks for confirmation before letting the form post — used for destructive
// server actions where a stray click shouldn't be irreversible.
export function ConfirmSubmitButton({
  message,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { message: string }) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
      {...props}
    >
      {children}
    </button>
  );
}
