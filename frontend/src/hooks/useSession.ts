import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Session } from "@/api/types";

export function useSession() {
  return useQuery<Session>({
    queryKey: ["session"],
    queryFn: () => api.get<Session>("/api/session"),
    staleTime: 30_000,
    retry: false,
  });
}
