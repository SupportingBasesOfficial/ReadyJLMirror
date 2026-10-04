import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

interface Branding {
  configured: boolean;
  brand_name?: string;
  brand_color?: string;
  logo_url?: string;
}

export function useBranding(tenantId: string | null | undefined) {
  const q = useQuery({
    queryKey: ["branding", tenantId],
    queryFn: () => api.get<Branding>("/api/v1/platform/branding"),
    enabled: !!tenantId,
    staleTime: 300_000,
  });

  useEffect(() => {
    const b = q.data;
    const root = document.documentElement;
    if (b?.configured && b.brand_color) {
      root.style.setProperty("--brand", b.brand_color);
    } else {
      root.style.removeProperty("--brand");
    }
  }, [q.data]);

  return q.data ?? null;
}
