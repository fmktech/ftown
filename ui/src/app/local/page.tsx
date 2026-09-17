import { LocalDashboard } from "@/components/LocalDashboard";
import SoloLocalPage from "@/components/local/SoloLocalPage";
export default function LocalPage() {
  return process.env.NEXT_PUBLIC_SOLO === "1" ? <SoloLocalPage /> : <LocalDashboard />;
}
