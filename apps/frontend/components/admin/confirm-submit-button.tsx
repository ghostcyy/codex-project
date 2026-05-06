"use client";

import type { ReactNode } from "react";

type ConfirmSubmitButtonProps = {
  action: (formData: FormData) => void | Promise<void>;
  children: ReactNode;
  className?: string;
  message: string;
};

export function ConfirmSubmitButton({
  action,
  children,
  className,
  message
}: ConfirmSubmitButtonProps) {
  return (
    <button
      formAction={action}
      className={className}
      onClick={(event) => {
        if (!window.confirm(message)) {
          event.preventDefault();
        }
      }}
    >
      {children}
    </button>
  );
}
