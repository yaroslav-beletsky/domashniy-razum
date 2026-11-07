import { redirect } from "next/navigation";

// Списка агентов больше нет: единая страница /agent (все колонки идут в первого агента).
export default function Page() {
  redirect("/agent");
}
