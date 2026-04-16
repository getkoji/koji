import { redirect } from "next/navigation";

export default function Home() {
  redirect("/t/acme-invoices");
}
