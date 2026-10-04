import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { StatusPublicPage } from "@/pages/StatusPublicPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/status/:slug" element={<StatusPublicPage />} />
        <Route path="/*" element={<Shell />} />
      </Routes>
    </BrowserRouter>
  );
}
