import { redirect } from "next/navigation";

// «Голос» слит в агента: дисклоузер «Голосовая цепочка» во вкладке «Диагностика» /agent.
export default function Page() {
  redirect("/agent");
}
