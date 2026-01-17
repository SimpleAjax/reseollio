import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ScheduleStatus } from "@/lib/api";
import {
    PlayCircle,
    PauseCircle,
    Trash2,
    Clock
} from "lucide-react";

interface ScheduleStatusBadgeProps {
    status: ScheduleStatus;
    className?: string;
}

const statusConfig: Record<ScheduleStatus, { label: string; icon: typeof Clock; className: string }> = {
    ACTIVE: {
        label: "Active",
        icon: PlayCircle,
        className: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
    },
    PAUSED: {
        label: "Paused",
        icon: PauseCircle,
        className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    },
    DELETED: {
        label: "Deleted",
        icon: Trash2,
        className: "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20",
    },
};

export function ScheduleStatusBadge({ status, className }: ScheduleStatusBadgeProps) {
    const config = statusConfig[status] || {
        label: status || "Unknown",
        icon: Clock,
        className: "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20",
    };
    const Icon = config.icon;

    return (
        <Badge
            variant="outline"
            className={cn(
                "flex items-center gap-1.5 font-medium transition-all hover:scale-105",
                config.className,
                status === "ACTIVE" && "animate-pulse",
                className
            )}
        >
            <Icon className="h-3.5 w-3.5" />
            {config.label}
        </Badge>
    );
}
