"use client";

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScheduleStatusBadge } from "@/components/schedule-status-badge";
import type { Schedule } from "@/lib/api";
import {
    Calendar,
    Clock,
    PlayCircle,
    PauseCircle,
    Trash2,
    Timer,
    Globe,
    Hash,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

interface ScheduleDetailModalProps {
    schedule: Schedule | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onPause: (schedule: Schedule) => void;
    onResume: (schedule: Schedule) => void;
    onDelete: (schedule: Schedule) => void;
}

export function ScheduleDetailModal({
    schedule,
    open,
    onOpenChange,
    onPause,
    onResume,
    onDelete,
}: ScheduleDetailModalProps) {
    if (!schedule) return null;

    const formatDate = (timestamp: number | null) => {
        if (!timestamp) return "—";
        return format(new Date(timestamp), "PPpp");
    };

    const formatRelativeTime = (timestamp: number | null) => {
        if (!timestamp) return null;
        return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-gradient-to-br from-card to-card/95">
                <DialogHeader>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center">
                                <Calendar className="h-5 w-5 text-white" />
                            </div>
                            <div>
                                <DialogTitle className="text-xl font-semibold">
                                    {schedule.name}
                                </DialogTitle>
                                <p className="text-sm text-muted-foreground font-mono">
                                    {schedule.id}
                                </p>
                            </div>
                        </div>
                        <ScheduleStatusBadge status={schedule.status} />
                    </div>
                </DialogHeader>

                <Separator />

                {/* Schedule Info Grid */}
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Timer className="h-4 w-4" />
                            Cron Expression
                        </div>
                        <p className="font-mono text-sm bg-secondary/50 px-3 py-2 rounded-md">
                            {schedule.cron}
                        </p>
                    </div>

                    <div className="space-y-1">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Globe className="h-4 w-4" />
                            Timezone
                        </div>
                        <p className="font-medium">{schedule.timezone}</p>
                    </div>

                    <div className="space-y-1">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Hash className="h-4 w-4" />
                            Handler Name
                        </div>
                        <p className="font-mono text-sm">{schedule.handlerName}</p>
                    </div>

                    <div className="space-y-1">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <PlayCircle className="h-4 w-4" />
                            Total Runs
                        </div>
                        <p className="font-medium">{schedule.totalRuns.toLocaleString()}</p>
                    </div>
                </div>

                <Separator />

                {/* Timing Section */}
                <div className="space-y-4">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                        <Clock className="h-4 w-4" />
                        Timing
                    </h3>

                    <div className="grid grid-cols-3 gap-4">
                        <div className="bg-secondary/30 p-4 rounded-lg space-y-1">
                            <p className="text-xs text-muted-foreground uppercase tracking-wide">Created</p>
                            <p className="text-sm font-medium" suppressHydrationWarning>
                                {formatDate(schedule.createdAt)}
                            </p>
                            <p className="text-xs text-muted-foreground" suppressHydrationWarning>
                                {formatRelativeTime(schedule.createdAt)}
                            </p>
                        </div>

                        <div className="bg-secondary/30 p-4 rounded-lg space-y-1">
                            <p className="text-xs text-muted-foreground uppercase tracking-wide">Next Run</p>
                            {schedule.nextRunAt ? (
                                <>
                                    <p className="text-sm font-medium" suppressHydrationWarning>
                                        {formatDate(schedule.nextRunAt)}
                                    </p>
                                    <p className="text-xs text-muted-foreground" suppressHydrationWarning>
                                        {formatRelativeTime(schedule.nextRunAt)}
                                    </p>
                                </>
                            ) : (
                                <p className="text-sm text-muted-foreground">—</p>
                            )}
                        </div>

                        <div className="bg-secondary/30 p-4 rounded-lg space-y-1">
                            <p className="text-xs text-muted-foreground uppercase tracking-wide">Last Run</p>
                            {schedule.lastRunAt ? (
                                <>
                                    <p className="text-sm font-medium" suppressHydrationWarning>
                                        {formatDate(schedule.lastRunAt)}
                                    </p>
                                    <p className="text-xs text-muted-foreground" suppressHydrationWarning>
                                        {formatRelativeTime(schedule.lastRunAt)}
                                    </p>
                                </>
                            ) : (
                                <p className="text-sm text-muted-foreground">Never</p>
                            )}
                        </div>
                    </div>
                </div>

                <Separator />

                {/* Actions */}
                <div className="flex items-center justify-end gap-2">
                    {schedule.status === "ACTIVE" && (
                        <Button
                            variant="outline"
                            onClick={() => {
                                onPause(schedule);
                                onOpenChange(false);
                            }}
                            className="gap-2"
                        >
                            <PauseCircle className="h-4 w-4" />
                            Pause Schedule
                        </Button>
                    )}
                    {schedule.status === "PAUSED" && (
                        <Button
                            variant="outline"
                            onClick={() => {
                                onResume(schedule);
                                onOpenChange(false);
                            }}
                            className="gap-2"
                        >
                            <PlayCircle className="h-4 w-4" />
                            Resume Schedule
                        </Button>
                    )}
                    <Button
                        variant="destructive"
                        onClick={() => {
                            onDelete(schedule);
                            onOpenChange(false);
                        }}
                        className="gap-2"
                    >
                        <Trash2 className="h-4 w-4" />
                        Delete
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
