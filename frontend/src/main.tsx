import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import "./index.css";
import App from "./App";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { ErrorBoundary } from "./components/ErrorBoundary";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

// Wires global toast feedback to all mutations — success and error
function MutationToastObserver() {
  const qc = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    const unsubscribe = qc.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.mutation.state.status === "error") {
        const err = event.mutation.state.error as { detail?: string; message?: string } | null;
        const msg = err?.detail ?? err?.message ?? "Ocorreu um erro. Tente novamente.";
        toast(msg, "error");
      }
    });
    return unsubscribe;
  }, [qc, toast]);

  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MutationToastObserver />
          <App />
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
