import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { PlatformAdminShell } from "@/components/PlatformAdminShell";
import { StatusPublicPage } from "@/pages/StatusPublicPage";
import { TVModePage } from "@/pages/TVModePage";
import { useSession } from "@/hooks/useSession";
import { FullPageSpinner } from "@/components/ui/spinner";

function AppRouter() {
  const { data: session, isLoading } = useSession();

  if (isLoading) return <FullPageSpinner />;

  // Platform admins têm workspace completamente separado
  if (session?.is_platform_admin) {
    return <PlatformAdminShell />;
  }

  return (
    <Routes>
      <Route path="/status/:slug" element={<StatusPublicPage />} />
      <Route path="/tv" element={<TVModePage />} />
      <Route path="/*" element={<Shell />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRouter />
    </BrowserRouter>
  );
}
