import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { StatusPublicPage } from "@/pages/StatusPublicPage";
import { TVModePage } from "@/pages/TVModePage";
import { ClientPortalPage } from "@/pages/ClientPortalPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/status/:slug" element={<StatusPublicPage />} />
        <Route path="/tv" element={<TVModePage />} />
        <Route path="/portal" element={<ClientPortalPage />} />
        <Route path="/*" element={<Shell />} />
      </Routes>
    </BrowserRouter>
  );
}
