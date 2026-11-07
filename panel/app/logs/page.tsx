import { redirect } from "next/navigation";

// «Логи» слиты в агента: дисклоузер «Живые логи» во вкладке «Диагностика» /agent.
// Лог конкретной колонки — как был, на странице колонки.
export default function Page() {
  redirect("/agent");
}
