import { Monitor, Moon, Sun } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import * as api from "@/lib/api";
import { useTheme, type ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

const NEXT: Record<ThemeMode, ThemeMode> = { light: "dark", dark: "system", system: "light" };
const LABEL: Record<ThemeMode, string> = { light: "浅色", dark: "深色", system: "跟随系统" };

export function ThemeToggle({ chrome = false, className }: { chrome?: boolean; className?: string }) {
  const [mode, setMode] = useTheme();
  const Icon = mode === "dark" ? Moon : mode === "system" ? Monitor : Sun;

  function cycle() {
    const next = NEXT[mode];
    setMode(next);
    void api.api.saveSettings({ theme: next }).catch((e) => {
      toast.error("主题保存失败", { description: api.asError(e) });
    });
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={cycle}
          aria-label={`主题：${LABEL[mode]}，点击切换`}
          className={cn(
            "size-8 rounded-lg",
            chrome
              ? "text-sidebar-foreground/60 hover:bg-white/8 hover:text-sidebar-foreground"
              : "text-muted-foreground",
            className,
          )}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">主题：{LABEL[mode]}</TooltipContent>
    </Tooltip>
  );
}
