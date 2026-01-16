import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { JobStatus } from "@/lib/dummy-data";
import {
    Clock,
    PlayCircle,
    CheckCircle2,
    AlertCircle,
    XCircle
} from "lucide-react";

interface StatusBadgeProps {
    status: JobStatus;
    className?: string;
}

const statusConfig = {
    PENDING: {
        label: "Pending",
        icon: Clock,
        className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    },
    RUNNING: {
        label: "Running",
        icon: PlayCircle,
        className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
    },
    SUCCESS: {
        label: "Success",
        icon: CheckCircle2,
        className: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
    },
    FAILED: {
        label: "Failed",
        icon: AlertCircle,
        className: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20",
    },
    DEAD: {
        label: "Dead",
        icon: XCircle,
        className: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
    },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
    const config = statusConfig[status];
    const Icon = config.icon;

    return (
        <Badge
            variant="outline"
            className={cn(
                "flex items-center gap-1.5 font-medium transition-all hover:scale-105",
                config.className,
                status === "RUNNING" && "animate-pulse",
                className
            )}
        >
            <Icon className="h-3.5 w-3.5" />
            {config.label}
        </Badge>
    );
}
