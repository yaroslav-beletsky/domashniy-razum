import { redirect } from "next/navigation";

// «Пульт» слит: статусные чипы живут в шапке каждой страницы,
// статистика и события — вкладка «Диагностика» на странице агента.
export default function Page() {
  redirect("/stations");
}
