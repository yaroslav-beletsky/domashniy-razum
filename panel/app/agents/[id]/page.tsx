import { redirect } from "next/navigation";

// Старая ссылка на конкретного агента: единая страница /agent/<slug>.
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/agent/${encodeURIComponent(id)}`);
}
