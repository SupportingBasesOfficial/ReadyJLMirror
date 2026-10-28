interface ToastOptions {
  title?: string;
  description?: string;
  variant?: "default" | "destructive";
}

export function useToast() {
  function toast({ title, description }: ToastOptions) {
    const msg = [title, description].filter(Boolean).join("\n");
    if (msg) console.info("[toast]", msg);
  }
  return { toast };
}
