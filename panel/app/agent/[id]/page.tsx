import AgentPage from "@/components/agent/agent-page";

// Старые ссылки /agents/<slug> редиректят на /agent; /agent/<slug> рендерит ту же страницу
// (внутри выбирается указанный агент, по умолчанию — первый, «наш»).
export default function Page() {
  return <AgentPage />;
}
