import { AppShell } from "@/components/app-shell";

export default function BoardsLayout({ children }: LayoutProps<"/boards">) {
  return <AppShell>{children}</AppShell>;
}
