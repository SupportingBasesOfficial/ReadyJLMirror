import { useSession } from "@/hooks/useSession";

/**
 * Returns true if the current session includes the given permission string.
 * Use for conditionally rendering write actions.
 *
 * Known permissions:
 *   "monitoring:operate"  — operator / admin
 *   "tenant:admin"        — tenant admin
 *   "audit:read"          — auditor + admin
 */
export function usePermission(permission: string): boolean {
  const { data: session } = useSession();
  return session?.permissions?.includes(permission) ?? false;
}

/** True when the user has any write capability (not a pure viewer). */
export function useCanOperate(): boolean {
  return usePermission("monitoring:operate");
}

/** True when the user can manage the tenant (users, keys, team). */
export function useCanAdmin(): boolean {
  return usePermission("tenant:admin");
}
