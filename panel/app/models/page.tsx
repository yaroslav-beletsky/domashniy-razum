import { redirect } from "next/navigation";

// «Модели» слиты в агента: дисклоузер «Модели LiteLLM» во вкладке «Диагностика» /agent.
export default function Page() {
  redirect("/agent");
}
